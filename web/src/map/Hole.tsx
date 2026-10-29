import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject, type RefObject } from 'react'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { SceneHole } from './sceneModel'
import { bodyZoomFactor } from './camera'
import { useFrameScheduler, useMapFrame } from './FrameBudget'
import { TickRing } from './Planet'
import { shadowTexture, SHADOW_SOLID } from './textures'
import { swatch } from '../lib/palette'
import { useSceneColours } from '../lib/sceneColours'
import { holeDropState, HOLE_DROP_RADIUS, type SimState } from './simulation'
import {
  HOLE_COUNT_FONT_PX,
  HOLE_COUNT_TRACKING_EM,
  HOLE_HINT_ARMED,
  HOLE_HINT_FONT_PX,
  HOLE_HINT_REFUSED,
  HOLE_HINT_REST,
  HOLE_HINT_TRACKING_EM,
  HOLE_LABEL_GAP,
  HOLE_LABEL_LINE_GAP_PX,
  HOLE_RADIUS,
  HOLE_TITLE,
  HOLE_TITLE_FONT_PX,
  HOLE_TITLE_TRACKING_EM,
  holeCountLine,
} from './visuals'
import {
  BODY_MOVE_MS,
  advancePointTween,
  prefersReducedMotion,
  retargetPointTween,
  createPointTween,
} from './transition'

/**
 * The corner trash (canvas 4a's black hole, spec
 * 2026-09-24-sessions-end-only-by-hand-design § 3): a world-space body pinned
 * bottom-right of the cluster field. Dropping a session's planet on it ends
 * the session (`trashDropFor` decides how); its label counts the sessions the
 * map does not draw, and clicking it opens the sidebar's HISTORY. The ring
 * flash on a drop that ends a session is driven imperatively through
 * `flashRef`, written by `SpaceMap` on release. Still drawn as the hole until
 * Claude Design draws the trash.
 *
 * Colours come from the colour theme's scene palette (canvas `Feature -
 * Colour themes` 1l): the horizon ring is `ink-50` (canvas `#f0f8ff`), the
 * halo `line`, the disc `void` — black on a dark theme, a dark ink on a
 * light one, where a soft shadow under the ring stands in for the glow.
 * Hovered, the ring rises to .8 and the halo to its drop-target strength;
 * refusing a body, the ring turns dashed and muted — a "no" without red.
 *
 * Geometry transcribed from canvas 4a's hole block (50px disc, horizon ring
 * at inset -2, drop halo at inset -46, label column left of it), converted
 * at the same 34px = 1 world unit as `simulation.ts`.
 */

/** World units per canvas-4a pixel — same conversion as simulation.ts. */
const PX = 1 / 34

/** Horizon ring: the disc's `inset:-2px` border. */
const RING_INNER = HOLE_RADIUS
const RING_OUTER = 27 * PX
const RING_OPACITY = 0.55
/** The drop halo's band (canvas gradient 42%→74% of the 71px box). The
 * radius itself lives in `simulation.ts` — it is the drop zone first,
 * a visual second. */
const HALO_BAND_INNER = 0.55 * HOLE_DROP_RADIUS
const HALO_OPACITY = 0.07
/** Halo boost while a body the trash takes is in hand… (drop-target signal) */
const HALO_ELIGIBLE_BOOST = 2
/** …and while it is inside the halo, where release ends it — or a refused body sits there. */
const HALO_ARMED_BOOST = 4
/** How fast the drop-target emphasis eases in and out, per second. */
const SIGNAL_EASE = 10
/** An eased emphasis this close to its target has arrived, and snaps to it so the map can stop drawing. */
const SIGNAL_SETTLED = 0.001
/** Hint colours per drop state; the copy (`HOLE_HINT_*`) is written imperatively, no re-render per frame. */
const HINT_COLOR_REST = swatch('ink-900', 0.42)
const HINT_COLOR_ELIGIBLE = swatch('ink-300', 0.75)
const HINT_COLOR_ARMED = swatch('ink-50', 0.95)
const HINT_COLOR_REFUSED = swatch('ink-900', 0.6)
/** Hovered (1l): the ring at .8. */
const RING_HOVER_OPACITY = 0.8
/** Refusing (1l): `1px dashed` muted ink, about as many dashes as a CSS border draws on the ring. */
const REFUSED_DASH_COUNT = 28
const REFUSED_DASH_DEG = 6.4
const REFUSED_OPACITY = 0.6
/** A light theme's shadow under the ring (1l `0 1px 5px` of `shadow` at .35), in place of a glow. */
const SHADOW_OFFSET = 1 * PX
const SHADOW_BLUR = 5 * PX
const SHADOW_OPACITY = 0.35
const SHADOW_SIZE = (2 * (RING_OUTER - SHADOW_BLUR)) / SHADOW_SOLID

/** The ring flash on a drop that ends a session (canvas: `this.flash = 0.45`). */
const FLASH_SEC = 0.45

const HOLE_Z = 0.03

export interface HoleProps {
  hole: SceneHole
  /**
   * Seconds of flash remaining; `SpaceMap` writes into it when a drop ends a
   * session and this component decays it — no React state, the same
   * frame-loop discipline as every other map animation.
   */
  flashRef: MutableRefObject<number>
  /**
   * The live simulation plus the current body drag (SpaceMap's own ref) —
   * what the drop-target signal reads each frame. Optional: the sandbox and
   * tests can mount the hole without a sim, and it stays inert.
   */
  simRef?: RefObject<SimState>
  dragRef?: RefObject<{ id: string } | null>
  /** Click: open the sidebar's HISTORY. Guarded by the caller against drag-releases. */
  onOpen?: () => void
}

export function Hole({ hole, flashRef, simRef, dragRef, onOpen }: HoleProps) {
  // The hole moves only when the cluster field's extent changes (a tag
  // appearing or emptying) — rare, and it walks there like everything else.
  const move = useRef(createPointTween(hole.x, hole.y, BODY_MOVE_MS)).current
  const groupRef = useRef<THREE.Group>(null)
  const palette = useSceneColours()
  const ringMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: RING_OPACITY,
        depthWrite: false,
      }),
    []
  )
  const haloMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: HALO_OPACITY,
        depthWrite: false,
      }),
    []
  )
  const refusedMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, visible: false }),
    []
  )
  const shadowMap = shadowTexture()
  const shadowMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, ...(shadowMap ? { map: shadowMap } : {}) }),
    [shadowMap]
  )
  useEffect(
    () => () => {
      ringMaterial.dispose()
      haloMaterial.dispose()
      refusedMaterial.dispose()
      shadowMaterial.dispose()
    },
    [ringMaterial, haloMaterial, refusedMaterial, shadowMaterial]
  )

  // The resting colours, before the first paint and on a colour theme change;
  // the frame loop tints from them while a drop is in play.
  useLayoutEffect(() => {
    ringMaterial.color.copy(palette['ink-50'])
    haloMaterial.color.copy(palette.line)
    refusedMaterial.color.copy(palette['ink-900'])
    shadowMaterial.color.copy(palette.shadow)
    shadowMaterial.opacity = SHADOW_OPACITY * (1 - palette.glowK)
    shadowMaterial.visible = shadowMaterial.opacity > 0.001
  }, [ringMaterial, haloMaterial, refusedMaterial, shadowMaterial, palette])

  /** The pointer is over the hole: a ref and a frame, no render (the ring eases there in the loop). */
  const scheduler = useFrameScheduler()
  const hoveredRef = useRef(false)
  const setHovered = (next: boolean) => {
    hoveredRef.current = next
    scheduler?.request()
  }

  useEffect(() => {
    retargetPointTween(move, hole.x, hole.y, prefersReducedMotion())
  }, [move, hole.x, hole.y])

  /** Eased 0..1 emphases of the drop states, advanced in the frame loop. */
  const eligibleLevel = useRef(0)
  const armedLevel = useRef(0)
  const refusedLevel = useRef(0)
  const hoverLevel = useRef(0)
  const hintRef = useRef<HTMLDivElement>(null)

  useMapFrame((state, delta) => {
    const moved = advancePointTween(move, delta)
    if (moved && groupRef.current) {
      groupRef.current.position.set(move.x.value, move.y.value, 0)
    }
    const zoomFactor = bodyZoomFactor(state.camera.zoom)
    if (groupRef.current) {
      // Same counter-zoom as the planets, so the landmark stays findable
      // when zoomed far out.
      groupRef.current.scale.setScalar(zoomFactor)
    }
    if (flashRef.current > 0) {
      flashRef.current = Math.max(0, flashRef.current - delta)
    }
    const k = flashRef.current / FLASH_SEC

    // Drop-target signal: while a body the trash takes is in hand the halo
    // advertises itself, and once the body is inside it the horizon arms —
    // release there ends it. A terminal body over the trash lights it just
    // as strongly, but in the warning colour: the "no" has to be as visible
    // as the "yes". The levels ease so the emphasis breathes in and out
    // rather than popping.
    const drop = simRef?.current
      ? holeDropState(simRef.current, dragRef?.current?.id ?? null, zoomFactor)
      : 'none'
    const ease = Math.min(1, delta * SIGNAL_EASE)
    const eligibleTarget = drop === 'none' ? 0 : 1
    const armedTarget = drop === 'armed' || drop === 'refused' ? 1 : 0
    const refusedTarget = drop === 'refused' ? 1 : 0
    const hoverTarget = hoveredRef.current && drop === 'none' ? 1 : 0
    eligibleLevel.current += (eligibleTarget - eligibleLevel.current) * ease
    armedLevel.current += (armedTarget - armedLevel.current) * ease
    refusedLevel.current += (refusedTarget - refusedLevel.current) * ease
    if (Math.abs(eligibleTarget - eligibleLevel.current) < SIGNAL_SETTLED) eligibleLevel.current = eligibleTarget
    if (Math.abs(armedTarget - armedLevel.current) < SIGNAL_SETTLED) armedLevel.current = armedTarget
    if (Math.abs(refusedTarget - refusedLevel.current) < SIGNAL_SETTLED) refusedLevel.current = refusedTarget
    hoverLevel.current += (hoverTarget - hoverLevel.current) * ease
    if (Math.abs(hoverTarget - hoverLevel.current) < SIGNAL_SETTLED) hoverLevel.current = hoverTarget
    const eligible = eligibleLevel.current
    const armed = armedLevel.current
    const refused = refusedLevel.current
    const hover = hoverLevel.current

    // Refusing, the solid ring gives way to the dashed muted one (1l).
    const ringOpacity =
      RING_OPACITY + (RING_HOVER_OPACITY - RING_OPACITY) * hover + (1 - RING_OPACITY) * Math.max(k, armed - refused)
    ringMaterial.opacity = Math.min(1, ringOpacity) * (1 - refused)
    ringMaterial.visible = ringMaterial.opacity > 0.001
    refusedMaterial.opacity = REFUSED_OPACITY * refused
    refusedMaterial.visible = refusedMaterial.opacity > 0.001
    haloMaterial.opacity =
      HALO_OPACITY *
      (1 +
        3 * k +
        (HALO_ELIGIBLE_BOOST - 1) * Math.max(eligible, hover) +
        (HALO_ARMED_BOOST - HALO_ELIGIBLE_BOOST) * armed * (1 - refused))

    if (hintRef.current) {
      const text =
        drop === 'armed' ? HOLE_HINT_ARMED : drop === 'refused' ? HOLE_HINT_REFUSED : HOLE_HINT_REST
      if (hintRef.current.textContent !== text) hintRef.current.textContent = text
      hintRef.current.style.color =
        drop === 'armed'
          ? HINT_COLOR_ARMED
          : drop === 'refused'
            ? HINT_COLOR_REFUSED
            : drop === 'eligible'
              ? HINT_COLOR_ELIGIBLE
              : HINT_COLOR_REST
    }
    // A drag in hand keeps the sim awake, which draws frames anyway; the
    // emphasis easing back out after the drop does not.
    return (
      moved ||
      flashRef.current > 0 ||
      eligibleLevel.current !== eligibleTarget ||
      armedLevel.current !== armedTarget ||
      refusedLevel.current !== refusedTarget ||
      hoverLevel.current !== hoverTarget
    )
  })

  return (
    <group ref={groupRef} position={[move.x.value, move.y.value, 0]}>
      {/* Drop halo — also the click target for "click to browse". */}
      <mesh
        position={[0, 0, HOLE_Z]}
        material={haloMaterial}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
        onClick={
          onOpen
            ? (e) => {
                e.stopPropagation()
                onOpen()
              }
            : undefined
        }
      >
        <ringGeometry args={[HALO_BAND_INNER, HOLE_DROP_RADIUS, 48]} />
      </mesh>
      {/* An invisible disc keeps the middle of the halo clickable too. */}
      <mesh
        position={[0, 0, HOLE_Z]}
        visible={false}
        onClick={
          onOpen
            ? (e) => {
                e.stopPropagation()
                onOpen()
              }
            : undefined
        }
      >
        <circleGeometry args={[HALO_BAND_INNER, 32]} />
      </mesh>

      {shadowMap && (
        <mesh position={[0, -SHADOW_OFFSET, HOLE_Z + 0.0005]} material={shadowMaterial}>
          <planeGeometry args={[SHADOW_SIZE, SHADOW_SIZE]} />
        </mesh>
      )}
      <mesh position={[0, 0, HOLE_Z + 0.001]} material={ringMaterial}>
        <ringGeometry args={[RING_INNER, RING_OUTER, 64]} />
      </mesh>
      <group position={[0, 0, HOLE_Z + 0.001]}>
        <TickRing
          count={REFUSED_DASH_COUNT}
          radius={(RING_INNER + RING_OUTER) / 2}
          widthDeg={REFUSED_DASH_DEG}
          length={RING_OUTER - RING_INNER}
          material={refusedMaterial}
        />
      </group>
      {/* The hole itself: flat `void`, in front of the ring's inner edge. */}
      <mesh position={[0, 0, HOLE_Z + 0.002]}>
        <circleGeometry args={[HOLE_RADIUS, 64]} />
        <meshBasicMaterial color={palette.void} />
      </mesh>

      {/* Label column, right-aligned against the hole (canvas 4a). Its type
          lives in `visuals.ts` (`holeLabelSizePx`), where the simulation
          measures it to keep bodies off it. */}
      <Html
        position={[-(HOLE_RADIUS + HOLE_LABEL_GAP), 0, HOLE_Z]}
        zIndexRange={[5, 0]}
        style={{ pointerEvents: 'none' }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: HOLE_LABEL_LINE_GAP_PX,
            whiteSpace: 'nowrap',
            transform: 'translate(-100%, -50%)',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          }}
        >
          <div
            style={{
              fontSize: HOLE_TITLE_FONT_PX,
              letterSpacing: `${HOLE_TITLE_TRACKING_EM}em`,
              color: swatch('ink-50', 0.8),
            }}
          >
            {HOLE_TITLE}
          </div>
          <div
            style={{
              fontSize: HOLE_COUNT_FONT_PX,
              letterSpacing: `${HOLE_COUNT_TRACKING_EM}em`,
              color: swatch('ink-900', 0.6),
            }}
          >
            {holeCountLine(hole.count)}
          </div>
          <div
            ref={hintRef}
            style={{
              fontSize: HOLE_HINT_FONT_PX,
              letterSpacing: `${HOLE_HINT_TRACKING_EM}em`,
              color: HINT_COLOR_REST,
            }}
          >
            {HOLE_HINT_REST}
          </div>
        </div>
      </Html>
    </group>
  )
}
