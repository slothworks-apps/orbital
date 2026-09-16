import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { ApiSession } from '../lib/types'
import {
  BODY_RADIUS,
  DIMMED_OPACITY,
  HALO_BREATH_MIN,
  HALO_BREATH_SEC,
  easeOut,
  oscillate,
  planetVisuals,
  truncateLabel,
} from './visuals'
import { glowTexture, bodyTexture, bodyIdleTexture } from './textures'

/**
 * Flat 2D parametric planet for the orthographic top-down space map.
 * Pure props in, no store/api imports — Task 9 wires this to live data.
 *
 * BINDING rule: hue (via `oklchTagColor`) always paints the atmosphere ring
 * and (for non-ended states) the bright core; session STATE is expressed
 * only through `planetVisuals` (tick spin, core blink, halo breathing,
 * ripple) plus a white core/ripple for needs-input — never by picking a
 * different hue.
 *
 * Layout per the "2d Instrument" canvas variant (`design/.../Planet
 * Variants.dc.html`) and the state sheet (artboard 1f in `Orbital.dc.html`):
 * a dark matte body disc inside a rotating tick ring, with a thin
 * counter-rotating 4-arc inner ring and a small bright core — reads as a
 * gauge, not a ball.
 */

// --- geometry constants (local units, before the `scale` prop is applied) --
// Transcribed from artboard 1f, whose five planets share a 100px body (50px
// radius) drawn here at BODY_RADIUS; `px()` below converts the export's own
// `inset:`/size values into scene units.

/** designPx → scene units, against 1f's 50px body radius. */
const px = (designPx: number) => (designPx / 50) * BODY_RADIUS

/** Ended body: flat `oklch(16% .01 230)` per the canvas, no gradient. */
const BODY_ENDED_LIGHTNESS = 0.16
const BODY_ENDED_CHROMA = 0.01
const BODY_ENDED_HUE = 230

/** 1px hue border straddling the body edge; alpha varies by state (1f: .6 working, .45 idle/needs-input, grey .35 ended). */
const BORDER_INNER = px(49.5)
const BORDER_OUTER = px(50.5)
const BORDER_OPACITY_ACTIVE = 0.6
const BORDER_OPACITY_IDLE = 0.45
const BORDER_OPACITY_ENDED = 0.35

/** Working body's `inset 0 0 0 6px rgba(0,0,0,.25)` — a dark rim inside the edge. */
const INNER_SHADE_INNER = px(50 - 6)
const INNER_SHADE_OUTER = px(50)
const INNER_SHADE_OPACITY = 0.25

/**
 * Breathing halo: `radial-gradient(circle, transparent 58%, hue/.18 72%,
 * transparent 80%)` on the inset -28 box (78px radius) → a band from 45px
 * to 62px, peaking at 56px.
 */
const HALO_RING_INNER = px(0.58 * 78)
const HALO_RING_OUTER = px(0.8 * 78)

/** Working body glow, `box-shadow: 0 0 22px hue/.25` → reaches 22px past the 50px edge. */
const GLOW_SIZE = px(2 * (50 + 22))
const GLOW_OPACITY = 0.25

/** Needs-input core glow, `0 0 14px rgba(255,255,255,.9), 0 0 30px hue/.6` around the 16px core. */
const CORE_GLOW_WHITE_SIZE = px(2 * (8 + 14))
const CORE_GLOW_WHITE_OPACITY = 0.9
const CORE_GLOW_HUE_SIZE = px(2 * (8 + 30))
const CORE_GLOW_HUE_OPACITY = 0.6

/** Thin inner arc ring: 4 × 60° arcs on a 90° pitch, inset -14 with a 2px mask band. */
const ARC_RING_INNER = px(64 - 2)
const ARC_RING_OUTER = px(64)
const ARC_COUNT = 4
const ARC_SWEEP_DEG = 60
const ARC_PITCH_DEG = 90

/** `orb-blink` keyframes: opacity 1 → .3 → 1. */
const BLINK_DEPTH = 0.7

/** `orb-pulse-out 2.4s ease-out`: scale 1 → 1.9, opacity .9 → 0, at the idle tick ring's radius (inset -21). */
const RIPPLE_MAX_SCALE = 1.9
const RIPPLE_DURATION_SEC = 2.4
const RIPPLE_START_OPACITY = 0.9
const RIPPLE_INNER = px(71 - 1)
const RIPPLE_OUTER = px(71)

/** Selection reticle: dashed ring at inset -42, brackets 10px long at ±50px outside the body (1f). */
const RETICLE_RADIUS = px(92)
const RETICLE_SPIN_SPEED = (Math.PI * 2) / 40
const RETICLE_DASH_SIZE = 0.08
const RETICLE_DASH_GAP = 0.06
const RETICLE_COLOR = '#e6f5ff'
const RETICLE_OPACITY = 0.7
const BRACKET_INSET = px(100)
const BRACKET_LENGTH = px(10)

/** Ended grey — `rgba(200,215,235)` in the canvas export. */
const GREY = '#c8d7eb'
const WHITE = '#ffffff'
const BLACK = '#000000'

/** Label sits `calc(100% + 34px)` under the body (2d/1f). */
const LABEL_OFFSET_Y = -(BODY_RADIUS + px(34))
const LABEL_COLOR_ACTIVE = 'rgba(220,235,255,.85)'
const LABEL_COLOR_DIMMED = 'rgba(160,190,225,.6)'

/**
 * Per-layer z offsets so the (visually transparent) halo never composites
 * OVER the opaque body/core — everything otherwise sits at the group's
 * local origin (z=0), which would let render order + alpha blending paint
 * the halo on top of, say, a white needs-input core and hue-tint it.
 * Ordered back (halo, furthest) to front (ripple/reticle, closest).
 */
const HALO_Z = -0.02
const BODY_Z = 0
const CORE_GLOW_Z = 0.005
const CORE_Z = 0.01
const RIPPLE_Z = 0.02
const RETICLE_Z = 0.02

/** Needs-input pill badge: `left: calc(100% + 10px); top: -12px` off the body box (artboard 1f). */
const BADGE_OFFSET_X = px(60)
const BADGE_OFFSET_Y = px(62)

export interface PlanetProps {
  session: ApiSession
  /** Tag hue (oklch hue angle, 0-360); state never changes this. */
  hue: number
  x: number
  y: number
  scale: number
  selected: boolean
  onClick?: (sessionId: string) => void
}

/**
 * Converts the app's `tagColor(hue)` (`oklch(80% 0.13 <hue>)`) into a
 * THREE.Color. three@0.162's `Color.setStyle` does not parse `oklch()`
 * strings, so the OKLCH -> linear-sRGB math (Björn Ottosson's OKLab) is
 * inlined here rather than passing the CSS string straight into a material.
 *
 * The matrices below produce LINEAR sRGB primaries — three's default
 * working color space — so the result is loaded via
 * `THREE.LinearSRGBColorSpace` (a no-op copy). Loading it as
 * `THREE.SRGBColorSpace` instead would tell three the values are still
 * gamma-encoded and re-linearize them, darkening every color and shifting
 * its hue (pinned by `colors.test.ts` against independently computed CSS
 * Color 4 reference hex values).
 */
export function oklchTagColor(hue: number, lightness = 0.8, chroma = 0.13): THREE.Color {
  const hRad = (hue * Math.PI) / 180
  const a = chroma * Math.cos(hRad)
  const b = chroma * Math.sin(hRad)

  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
  const s_ = lightness - 0.0894841775 * a - 1.291485548 * b

  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

  const color = new THREE.Color()
  color.setRGB(
    THREE.MathUtils.clamp(r, 0, 1),
    THREE.MathUtils.clamp(g, 0, 1),
    THREE.MathUtils.clamp(bl, 0, 1),
    THREE.LinearSRGBColorSpace
  )
  return color
}

/** Flat ended-body color (`oklch(16% .01 230)` in the canvas) — active bodies use `bodyTexture()`. */
const BODY_ENDED_COLOR = oklchTagColor(BODY_ENDED_HUE, BODY_ENDED_LIGHTNESS, BODY_ENDED_CHROMA)

/**
 * Radial ring of thin instanced tick marks; rotated as a group in useFrame.
 * Exported so `Moon.tsx` reuses the same primitive for its micro tick ring.
 *
 * `widthDeg` is the export's angular tick width (the "on" slice of its
 * `repeating-conic-gradient`); the chord it subtends at `radius` is the
 * plane's width, so a tick keeps the design's duty cycle at any radius.
 */
export function TickRing({
  count,
  radius,
  widthDeg,
  length,
  color,
  opacity = 1,
}: {
  count: number
  radius: number
  widthDeg: number
  length: number
  color: THREE.Color | string
  opacity?: number
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null!)
  const width = radius * widthDeg * (Math.PI / 180)

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D()
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2
      dummy.position.set(radius * Math.cos(angle), radius * Math.sin(angle), 0)
      // planeGeometry's long axis (length, local Y) defaults to pointing at
      // 90°; adding 90° here aligns it with the radius direction at this
      // tick's own placement angle, so ticks read as radial "clock marks"
      // (matching the canvas) rather than tangential dashes.
      dummy.rotation.z = angle + Math.PI / 2
      dummy.updateMatrix()
      meshRef.current.setMatrixAt(i, dummy.matrix)
    }
    meshRef.current.instanceMatrix.needsUpdate = true
  }, [count, radius])

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
      <planeGeometry args={[width, length]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </instancedMesh>
  )
}

/**
 * The thin inner instrument ring:
 * `repeating-conic-gradient(hue/.5 0 60deg, transparent 60deg 90deg)` masked
 * to a 2px band at inset -14, spinning `orb-spin 60s linear infinite reverse`
 * (artboard 1f / 1a / 2d). Four 60° arcs with 30° gaps, counter-rotating
 * against the tick ring.
 */
export function ArcRing({ color, opacity }: { color: THREE.Color | string; opacity: number }) {
  return (
    <>
      {Array.from({ length: ARC_COUNT }, (_, i) => (
        <mesh key={i}>
          <ringGeometry
            args={[
              ARC_RING_INNER,
              ARC_RING_OUTER,
              48,
              1,
              (i * ARC_PITCH_DEG * Math.PI) / 180,
              (ARC_SWEEP_DEG * Math.PI) / 180,
            ]}
          />
          <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
        </mesh>
      ))}
    </>
  )
}

/** One L-shaped corner bracket of the selection reticle. */
function CornerBracket({ signX, signY, color }: { signX: 1 | -1; signY: 1 | -1; color: THREE.Color | string }) {
  // Memoized: a fresh array reference every render makes drei's <Line> tear
  // down and rebuild its live geometry/material each time the parent
  // re-renders, even though these 4 points never actually change.
  const points = useMemo<[number, number, number][]>(() => {
    const cx = signX * BRACKET_INSET
    const cy = signY * BRACKET_INSET
    return [
      [cx - signX * BRACKET_LENGTH, cy, 0],
      [cx, cy, 0],
      [cx, cy - signY * BRACKET_LENGTH, 0],
    ]
  }, [signX, signY])

  // 1f draws the brackets `1.5px solid #fff`, opaque — only the dashed ring
  // is tinted/faded.
  return <Line points={points} color={color} lineWidth={1.5} />
}

/** Selection reticle: a slow dashed ring + 4 corner brackets. */
function SelectionReticle({ groupRef }: { groupRef: RefObject<THREE.Group | null> }) {
  const ringPoints = useMemo(() => {
    const pts: [number, number, number][] = []
    const segments = 96
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      pts.push([RETICLE_RADIUS * Math.cos(angle), RETICLE_RADIUS * Math.sin(angle), 0])
    }
    return pts
  }, [])

  return (
    <group ref={groupRef} position={[0, 0, RETICLE_Z]}>
      <Line
        points={ringPoints}
        color={RETICLE_COLOR}
        lineWidth={1}
        dashed
        dashSize={RETICLE_DASH_SIZE}
        gapSize={RETICLE_DASH_GAP}
        transparent
        opacity={RETICLE_OPACITY}
      />
      <CornerBracket signX={1} signY={1} color={WHITE} />
      <CornerBracket signX={-1} signY={1} color={WHITE} />
      <CornerBracket signX={1} signY={-1} color={WHITE} />
      <CornerBracket signX={-1} signY={-1} color={WHITE} />
    </group>
  )
}

/** "NEEDS INPUT" pill badge — mono, blinking dot, right of the planet (state sheet artboard 1f). */
function NeedsInputBadge() {
  // zIndexRange keeps map text under the z-10 side panels and z-50 dialogs
  // (drei's default range is in the millions).
  return (
    <Html position={[BADGE_OFFSET_X, BADGE_OFFSET_Y, CORE_Z]} zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          borderRadius: 999,
          background: 'rgba(6,10,20,.85)',
          border: '1px solid rgba(240,248,255,.6)',
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 9.5,
          letterSpacing: '0.1em',
          color: '#fff',
          whiteSpace: 'nowrap',
        }}
      >
        <span
          aria-hidden
          className="orbital-pulse"
          style={{ width: 5, height: 5, borderRadius: '50%', background: '#fff' }}
        />
        NEEDS INPUT
      </span>
    </Html>
  )
}

export function Planet({ session, hue, x, y, scale, selected, onClick }: PlanetProps) {
  const visuals = useMemo(() => planetVisuals(session.status, selected), [session.status, selected])
  const color = useMemo(() => oklchTagColor(hue), [hue])
  const tickColor = visuals.dimmed ? GREY : color
  const coreColor = session.status === 'needs_input' ? WHITE : color
  const glowMap = glowTexture()
  // 1f: only the working body carries `box-shadow: 0 0 22px hue/.25`; the
  // needs-input planet's glow lives on its white core instead.
  const bodyMap = session.status === 'working' ? bodyTexture() : bodyIdleTexture()
  const glowOn = session.status === 'working'
  const coreGlowOn = session.status === 'needs_input'
  const borderOpacity = visuals.dimmed
    ? BORDER_OPACITY_ENDED
    : session.status === 'working'
      ? BORDER_OPACITY_ACTIVE
      : BORDER_OPACITY_IDLE
  // The export wraps an ended planet in `opacity:.6`, which multiplies every
  // layer's own alpha — reproduced here per material.
  const dim = visuals.dimmed ? DIMMED_OPACITY : 1

  const tickGroupRef = useRef<THREE.Group>(null!)
  const arcGroupRef = useRef<THREE.Group>(null!)
  const coreMaterialRef = useRef<THREE.MeshBasicMaterial>(null!)
  const haloMaterialRef = useRef<THREE.MeshBasicMaterial>(null!)
  const rippleRef = useRef<THREE.Mesh>(null!)
  const reticleGroupRef = useRef<THREE.Group>(null!)
  const rippleElapsed = useRef(0)

  useFrame((state, delta) => {
    if (visuals.tickSpin !== 0 && tickGroupRef.current) {
      tickGroupRef.current.rotation.z += visuals.tickSpin * delta
    }

    if (visuals.arcSpin !== 0 && arcGroupRef.current) {
      arcGroupRef.current.rotation.z += visuals.arcSpin * delta
    }

    if (coreMaterialRef.current) {
      // `orb-blink`: opacity 1 → .3 → 1 over corePulseSec (a blink, not a scale pulse).
      const blink =
        visuals.corePulse > 0
          ? 1 - BLINK_DEPTH * visuals.corePulse * oscillate(state.clock.elapsedTime, visuals.corePulseSec)
          : 1
      coreMaterialRef.current.opacity = visuals.coreOpacity * blink * dim
    }

    if (haloMaterialRef.current) {
      // `orb-ring`: opacity ×.55 → ×1 → ×.55 over 2.4s.
      const breath = visuals.haloBreathes
        ? HALO_BREATH_MIN + (1 - HALO_BREATH_MIN) * oscillate(state.clock.elapsedTime, HALO_BREATH_SEC)
        : 1
      haloMaterialRef.current.opacity = visuals.haloOpacity * breath
    }

    if (visuals.rippleActive) {
      rippleElapsed.current = (rippleElapsed.current + delta) % RIPPLE_DURATION_SEC
      const progress = easeOut(rippleElapsed.current / RIPPLE_DURATION_SEC)
      if (rippleRef.current) {
        rippleRef.current.scale.setScalar(1 + progress * (RIPPLE_MAX_SCALE - 1))
        const mat = rippleRef.current.material as THREE.MeshBasicMaterial
        mat.opacity = RIPPLE_START_OPACITY * (1 - progress)
      }
    } else {
      rippleElapsed.current = 0
    }

    if (visuals.reticle && reticleGroupRef.current) {
      reticleGroupRef.current.rotation.z += RETICLE_SPIN_SPEED * delta
    }
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    onClick?.(session.id)
  }

  return (
    <group position={[x, y, 0]} scale={scale} onClick={onClick ? handleClick : undefined}>
      {glowOn && glowMap && (
        <mesh position={[0, 0, HALO_Z]}>
          <planeGeometry args={[GLOW_SIZE, GLOW_SIZE]} />
          <meshBasicMaterial color={color} transparent opacity={GLOW_OPACITY} depthWrite={false} map={glowMap} />
        </mesh>
      )}

      {visuals.haloOpacity > 0 && (
        <mesh position={[0, 0, HALO_Z]}>
          <ringGeometry args={[HALO_RING_INNER, HALO_RING_OUTER, 64]} />
          <meshBasicMaterial
            ref={haloMaterialRef}
            color={color}
            transparent
            opacity={visuals.haloOpacity}
            depthWrite={false}
          />
        </mesh>
      )}

      {visuals.arcOpacity > 0 && (
        <group ref={arcGroupRef} position={[0, 0, HALO_Z]}>
          <ArcRing color={color} opacity={visuals.arcOpacity} />
        </group>
      )}

      <mesh position={[0, 0, BODY_Z]}>
        <circleGeometry args={[BODY_RADIUS, 48]} />
        {visuals.dimmed || !bodyMap ? (
          <meshBasicMaterial color={BODY_ENDED_COLOR} transparent opacity={dim} />
        ) : (
          <meshBasicMaterial map={bodyMap} />
        )}
      </mesh>

      {session.status === 'working' && (
        <mesh position={[0, 0, BODY_Z]}>
          <ringGeometry args={[INNER_SHADE_INNER, INNER_SHADE_OUTER, 48]} />
          <meshBasicMaterial color={BLACK} transparent opacity={INNER_SHADE_OPACITY} depthWrite={false} />
        </mesh>
      )}

      <mesh position={[0, 0, BODY_Z]}>
        <ringGeometry args={[BORDER_INNER, BORDER_OUTER, 64]} />
        <meshBasicMaterial
          color={visuals.dimmed ? GREY : color}
          transparent
          opacity={borderOpacity * dim}
          depthWrite={false}
        />
      </mesh>

      <group ref={tickGroupRef} position={[0, 0, BODY_Z]}>
        <TickRing
          key={visuals.tickCount}
          count={visuals.tickCount}
          radius={visuals.tickRadius}
          widthDeg={visuals.tickWidthDeg}
          length={visuals.tickLength}
          color={tickColor}
          opacity={visuals.tickOpacity * dim}
        />
      </group>

      {coreGlowOn && glowMap && (
        <>
          <mesh position={[0, 0, CORE_GLOW_Z]}>
            <planeGeometry args={[CORE_GLOW_HUE_SIZE, CORE_GLOW_HUE_SIZE]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={CORE_GLOW_HUE_OPACITY}
              depthWrite={false}
              map={glowMap}
            />
          </mesh>
          <mesh position={[0, 0, CORE_GLOW_Z]}>
            <planeGeometry args={[CORE_GLOW_WHITE_SIZE, CORE_GLOW_WHITE_SIZE]} />
            <meshBasicMaterial
              color={WHITE}
              transparent
              opacity={CORE_GLOW_WHITE_OPACITY}
              depthWrite={false}
              map={glowMap}
            />
          </mesh>
        </>
      )}

      {visuals.coreOpacity > 0 && (
        <mesh position={[0, 0, CORE_Z]}>
          <circleGeometry args={[visuals.coreRadius, 32]} />
          <meshBasicMaterial ref={coreMaterialRef} color={coreColor} transparent opacity={visuals.coreOpacity * dim} />
        </mesh>
      )}

      {visuals.rippleActive && (
        <mesh ref={rippleRef} position={[0, 0, RIPPLE_Z]}>
          <ringGeometry args={[RIPPLE_INNER, RIPPLE_OUTER, 48]} />
          <meshBasicMaterial color={WHITE} transparent opacity={RIPPLE_START_OPACITY} depthWrite={false} />
        </mesh>
      )}

      {visuals.reticle && <SelectionReticle groupRef={reticleGroupRef} />}

      {visuals.rippleActive && <NeedsInputBadge />}

      <Html center position={[0, LABEL_OFFSET_Y, 0]} zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
        <span
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 11,
            letterSpacing: '0.06em',
            color: visuals.dimmed ? LABEL_COLOR_DIMMED : LABEL_COLOR_ACTIVE,
            whiteSpace: 'nowrap',
          }}
        >
          {truncateLabel(session.title)}
        </span>
      </Html>
    </group>
  )
}
