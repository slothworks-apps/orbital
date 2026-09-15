import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { ApiSession } from '../lib/types'
import { planetVisuals } from './visuals'

/**
 * Flat 2D parametric planet for the orthographic top-down space map.
 * Pure props in, no store/api imports — Task 9 wires this to live data.
 *
 * BINDING rule: hue (via `oklchTagColor`) always paints the core/atmosphere;
 * session STATE is expressed only through `planetVisuals` (tick spin, core
 * pulse, halo breathing, ripple) plus a white core/ripple for needs-input —
 * never by picking a different hue.
 */

// --- geometry constants (local units, before the `scale` prop is applied) --

const CORE_RADIUS = 0.4
const ATMOSPHERE_INNER = 0.46
const ATMOSPHERE_OUTER = 0.52
const HALO_RADIUS = 0.95

const TICK_COUNT = 20
const TICK_RADIUS = 0.68
const TICK_WIDTH = 0.03
const TICK_LENGTH = 0.1

const RIPPLE_MIN_SCALE = 0.55
const RIPPLE_MAX_SCALE = 1.9
const RIPPLE_DURATION_SEC = 1.6
const RIPPLE_INNER = 0.5
const RIPPLE_OUTER = 0.56

const CORE_PULSE_SPEED = 2.2
const CORE_PULSE_AMPLITUDE = 0.14
const HALO_BREATH_SPEED = 1.1
const HALO_BREATH_AMPLITUDE = 0.3

const RETICLE_RADIUS = 0.85
const RETICLE_SPIN_SPEED = 0.12
const RETICLE_DASH_SIZE = 0.08
const RETICLE_DASH_GAP = 0.06
const BRACKET_INSET = 0.62
const BRACKET_LENGTH = 0.18

const ENDED_LINE_OPACITY = 0.6
const GREY = '#a0b4cc'
const WHITE = '#ffffff'

const LABEL_OFFSET_Y = -(HALO_RADIUS + 0.22)

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
  color.setRGB(THREE.MathUtils.clamp(r, 0, 1), THREE.MathUtils.clamp(g, 0, 1), THREE.MathUtils.clamp(bl, 0, 1), THREE.SRGBColorSpace)
  return color
}

/**
 * Radial ring of thin instanced tick marks; rotated as a group in useFrame.
 * Exported so `Moon.tsx` reuses the same primitive for its micro tick ring.
 */
export function TickRing({
  count,
  radius,
  width,
  length,
  color,
  opacity = 1,
}: {
  count: number
  radius: number
  width: number
  length: number
  color: THREE.Color | string
  opacity?: number
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null!)

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D()
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2
      dummy.position.set(radius * Math.cos(angle), radius * Math.sin(angle), 0)
      dummy.rotation.z = angle
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

/** One L-shaped corner bracket of the selection reticle. */
function CornerBracket({ signX, signY, color }: { signX: 1 | -1; signY: 1 | -1; color: THREE.Color | string }) {
  const cx = signX * BRACKET_INSET
  const cy = signY * BRACKET_INSET
  const points: [number, number, number][] = [
    [cx - signX * BRACKET_LENGTH, cy, 0],
    [cx, cy, 0],
    [cx, cy - signY * BRACKET_LENGTH, 0],
  ]
  return <Line points={points} color={color} lineWidth={1} transparent opacity={0.85} />
}

/** Selection reticle: a slow dashed ring + 4 corner brackets. */
function SelectionReticle({ color, groupRef }: { color: THREE.Color | string; groupRef: RefObject<THREE.Group | null> }) {
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
    <group ref={groupRef}>
      <Line
        points={ringPoints}
        color={color}
        lineWidth={1}
        dashed
        dashSize={RETICLE_DASH_SIZE}
        gapSize={RETICLE_DASH_GAP}
        transparent
        opacity={0.7}
      />
      <CornerBracket signX={1} signY={1} color={color} />
      <CornerBracket signX={-1} signY={1} color={color} />
      <CornerBracket signX={1} signY={-1} color={color} />
      <CornerBracket signX={-1} signY={-1} color={color} />
    </group>
  )
}

export function Planet({ session, hue, x, y, scale, selected, onClick }: PlanetProps) {
  const visuals = useMemo(() => planetVisuals(session.status, selected), [session.status, selected])
  const color = useMemo(() => oklchTagColor(hue), [hue])
  const tickColor = visuals.dimmed ? GREY : color
  const coreColor = session.status === 'needs_input' ? WHITE : color

  const tickGroupRef = useRef<THREE.Group>(null!)
  const coreRef = useRef<THREE.Mesh>(null!)
  const haloMaterialRef = useRef<THREE.MeshBasicMaterial>(null!)
  const rippleRef = useRef<THREE.Mesh>(null!)
  const reticleGroupRef = useRef<THREE.Group>(null!)
  const rippleElapsed = useRef(0)

  useFrame((state, delta) => {
    if (visuals.tickSpin > 0 && tickGroupRef.current) {
      tickGroupRef.current.rotation.z += visuals.tickSpin * delta
    }

    if (coreRef.current) {
      const pulse =
        visuals.corePulse > 0
          ? 1 + Math.sin(state.clock.elapsedTime * CORE_PULSE_SPEED) * CORE_PULSE_AMPLITUDE * visuals.corePulse
          : 1
      coreRef.current.scale.setScalar(pulse)
    }

    if (haloMaterialRef.current) {
      const breathing =
        visuals.haloOpacity > 0 && session.status === 'working'
          ? visuals.haloOpacity *
            (1 - HALO_BREATH_AMPLITUDE / 2 + (HALO_BREATH_AMPLITUDE / 2) * Math.sin(state.clock.elapsedTime * HALO_BREATH_SPEED))
          : visuals.haloOpacity
      haloMaterialRef.current.opacity = breathing
    }

    if (visuals.rippleActive) {
      rippleElapsed.current = (rippleElapsed.current + delta) % RIPPLE_DURATION_SEC
      const progress = rippleElapsed.current / RIPPLE_DURATION_SEC
      if (rippleRef.current) {
        rippleRef.current.scale.setScalar(RIPPLE_MIN_SCALE + progress * (RIPPLE_MAX_SCALE - RIPPLE_MIN_SCALE))
        const mat = rippleRef.current.material as THREE.MeshBasicMaterial
        mat.opacity = 1 - progress
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
      <mesh>
        <circleGeometry args={[HALO_RADIUS, 48]} />
        <meshBasicMaterial ref={haloMaterialRef} color={color} transparent opacity={visuals.haloOpacity} depthWrite={false} />
      </mesh>

      <mesh>
        <ringGeometry args={[ATMOSPHERE_INNER, ATMOSPHERE_OUTER, 64]} />
        <meshBasicMaterial color={color} transparent opacity={visuals.dimmed ? ENDED_LINE_OPACITY : 1} depthWrite={false} />
      </mesh>

      <group ref={tickGroupRef}>
        <TickRing
          count={TICK_COUNT}
          radius={TICK_RADIUS}
          width={TICK_WIDTH}
          length={TICK_LENGTH}
          color={tickColor}
          opacity={visuals.dimmed ? ENDED_LINE_OPACITY : 1}
        />
      </group>

      {!visuals.dimmed && (
        <mesh ref={coreRef}>
          <circleGeometry args={[CORE_RADIUS, 32]} />
          <meshBasicMaterial color={coreColor} />
        </mesh>
      )}

      {visuals.rippleActive && (
        <mesh ref={rippleRef}>
          <ringGeometry args={[RIPPLE_INNER, RIPPLE_OUTER, 48]} />
          <meshBasicMaterial color={WHITE} transparent opacity={1} depthWrite={false} />
        </mesh>
      )}

      {visuals.reticle && <SelectionReticle color={color} groupRef={reticleGroupRef} />}

      <Html center position={[0, LABEL_OFFSET_Y, 0]} style={{ pointerEvents: 'none' }}>
        <span
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 11,
            letterSpacing: '0.06em',
            color: 'rgba(220,235,255,.85)',
            whiteSpace: 'nowrap',
          }}
        >
          {session.title}
        </span>
      </Html>
    </group>
  )
}
