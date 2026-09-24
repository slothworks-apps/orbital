import { useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from 'react'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { SceneHole } from './sceneModel'
import { bodyZoomFactor } from './camera'
import { useMapFrame } from './FrameBudget'
import { holeDropState, HOLE_DROP_RADIUS, type SimState } from './simulation'
import {
  HOLE_COUNT_FONT_PX,
  HOLE_COUNT_TRACKING_EM,
  HOLE_HINT_ARMED,
  HOLE_HINT_FONT_PX,
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
 * The corner black hole (canvas 4a, spec 2026-09-18-tag-clusters-design § 4):
 * a world-space body pinned bottom-right of the cluster field. It is the
 * history index — its label counts the sessions the map no longer draws, and
 * clicking it opens the sidebar's HISTORY. Absorption feedback (the ring
 * flash) is driven imperatively through `flashRef`, written by the sim
 * driver the moment a body crosses the horizon.
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
const RING_COLOR = '#f0f8ff'
const RING_OPACITY = 0.55
/** The drop halo's band (canvas gradient 42%→74% of the 71px box). The
 * radius itself lives in `simulation.ts` — it is the absorption zone first,
 * a visual second. */
const HALO_BAND_INNER = 0.55 * HOLE_DROP_RADIUS
const HALO_COLOR = '#96cdff'
const HALO_OPACITY = 0.07
/** Halo boost while an absorbable body is in hand… (drop-target signal) */
const HALO_ELIGIBLE_BOOST = 2
/** …and while it is inside the halo, where release absorbs. */
const HALO_ARMED_BOOST = 4
/** How fast the drop-target emphasis eases in and out, per second. */
const SIGNAL_EASE = 10
/** An eased emphasis this close to its target has arrived, and snaps to it so the map can stop drawing. */
const SIGNAL_SETTLED = 0.001
/** Hint colours per drop state; the copy (`HOLE_HINT_REST`/`_ARMED`) is written imperatively, no re-render per frame. */
const HINT_COLOR_REST = 'rgba(160,190,225,.42)'
const HINT_COLOR_ELIGIBLE = 'rgba(200,225,255,.75)'
const HINT_COLOR_ARMED = 'rgba(240,248,255,.95)'

/** The ring flash on absorption (canvas: `this.flash = 0.45`). */
const FLASH_SEC = 0.45

const HOLE_Z = 0.03

export interface HoleProps {
  hole: SceneHole
  /**
   * Seconds of flash remaining; the sim driver writes `FLASH_SEC` into it on
   * each absorption and this component decays it — no React state, the same
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
  const ringMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: RING_COLOR,
        transparent: true,
        opacity: RING_OPACITY,
        depthWrite: false,
      }),
    []
  )
  const haloMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: HALO_COLOR,
        transparent: true,
        opacity: HALO_OPACITY,
        depthWrite: false,
      }),
    []
  )
  useEffect(
    () => () => {
      ringMaterial.dispose()
      haloMaterial.dispose()
    },
    [ringMaterial, haloMaterial]
  )

  useEffect(() => {
    retargetPointTween(move, hole.x, hole.y, prefersReducedMotion())
  }, [move, hole.x, hole.y])

  /** Eased 0..1 emphases of the two drop states, advanced in the frame loop. */
  const eligibleLevel = useRef(0)
  const armedLevel = useRef(0)
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

    // Drop-target signal: while an absorbable body is in hand the halo
    // advertises itself, and once the body is inside it the horizon arms —
    // release there absorbs. Both levels ease so the emphasis breathes in
    // and out rather than popping.
    const drop = simRef?.current
      ? holeDropState(simRef.current, dragRef?.current?.id ?? null, zoomFactor)
      : 'none'
    const ease = Math.min(1, delta * SIGNAL_EASE)
    const eligibleTarget = drop === 'none' ? 0 : 1
    const armedTarget = drop === 'armed' ? 1 : 0
    eligibleLevel.current += (eligibleTarget - eligibleLevel.current) * ease
    armedLevel.current += (armedTarget - armedLevel.current) * ease
    if (Math.abs(eligibleTarget - eligibleLevel.current) < SIGNAL_SETTLED) eligibleLevel.current = eligibleTarget
    if (Math.abs(armedTarget - armedLevel.current) < SIGNAL_SETTLED) armedLevel.current = armedTarget
    const eligible = eligibleLevel.current
    const armed = armedLevel.current

    ringMaterial.opacity = RING_OPACITY + (1 - RING_OPACITY) * Math.max(k, armed)
    haloMaterial.opacity =
      HALO_OPACITY *
      (1 + 3 * k + (HALO_ELIGIBLE_BOOST - 1) * eligible + (HALO_ARMED_BOOST - HALO_ELIGIBLE_BOOST) * armed)

    if (hintRef.current) {
      const text = drop === 'armed' ? HOLE_HINT_ARMED : HOLE_HINT_REST
      if (hintRef.current.textContent !== text) hintRef.current.textContent = text
      hintRef.current.style.color =
        drop === 'armed' ? HINT_COLOR_ARMED : drop === 'eligible' ? HINT_COLOR_ELIGIBLE : HINT_COLOR_REST
    }
    // A drag in hand keeps the sim awake, which draws frames anyway; the
    // emphasis easing back out after the drop does not.
    return (
      moved ||
      flashRef.current > 0 ||
      eligibleLevel.current !== eligibleTarget ||
      armedLevel.current !== armedTarget
    )
  })

  return (
    <group ref={groupRef} position={[move.x.value, move.y.value, 0]}>
      {/* Drop halo — also the click target for "click to browse". */}
      <mesh
        position={[0, 0, HOLE_Z]}
        material={haloMaterial}
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

      <mesh position={[0, 0, HOLE_Z + 0.001]} material={ringMaterial}>
        <ringGeometry args={[RING_INNER, RING_OUTER, 64]} />
      </mesh>
      {/* The hole itself: flat black, in front of the ring's inner edge. */}
      <mesh position={[0, 0, HOLE_Z + 0.002]}>
        <circleGeometry args={[HOLE_RADIUS, 64]} />
        <meshBasicMaterial color="#000000" />
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
              color: 'rgba(240,248,255,.8)',
            }}
          >
            {HOLE_TITLE}
          </div>
          <div
            style={{
              fontSize: HOLE_COUNT_FONT_PX,
              letterSpacing: `${HOLE_COUNT_TRACKING_EM}em`,
              color: 'rgba(160,190,225,.6)',
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
