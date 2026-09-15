import { useMemo, useRef, type ComponentRef, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { Subagent } from '../lib/types'
import { moonVisuals } from './visuals'
import { oklchTagColor, TickRing } from './Planet'

/**
 * Small disc orbiting its parent planet, driven purely by props + an
 * internal `useFrame` clock (`orbitRadius`, `phase`). No store/api imports —
 * Task 9 wires this to live `subagent` WS events.
 *
 * BINDING rule: hue paints the core; subagent STATE is carried only by
 * `moonVisuals` (tick spin, core opacity, ripple, dashed materializing
 * shell) plus a white ripple for needs-input, never by re-hue-ing.
 */

const MOON_CORE_RADIUS = 0.14
const MOON_TICK_COUNT = 10
const MOON_TICK_RADIUS = 0.24
const MOON_TICK_WIDTH = 0.014
const MOON_TICK_LENGTH = 0.045

const MOON_RIPPLE_MIN_SCALE = 0.6
const MOON_RIPPLE_MAX_SCALE = 1.8
const MOON_RIPPLE_DURATION_SEC = 1.3
const MOON_RIPPLE_INNER = 0.17
const MOON_RIPPLE_OUTER = 0.2

const MOON_SHELL_RADIUS = 0.2
const MOON_MATERIALIZE_FADE_IN_SEC = 1.2

/** Angular orbit speed, radians/sec, at orbitRadius = 1 (scaled by 1/radius so closer moons don't look slower). */
const ORBIT_ANGULAR_SPEED = 0.5

const GREY = '#a0b4cc'
const WHITE = '#ffffff'

export interface MoonProps {
  subagent: Subagent
  /** Parent planet's tag hue (oklch hue angle, 0-360); state never changes this. */
  hue: number
  parentX: number
  parentY: number
  orbitRadius: number
  /** Starting angle on the orbit, in radians — keeps multiple moons spread out. */
  phase: number
}

/** Dashed orbit ring traced once around the parent planet's position. */
function OrbitRing({ radius, color, opacity }: { radius: number; color: THREE.Color | string; opacity: number }) {
  const points = useMemo(() => {
    const pts: [number, number, number][] = []
    const segments = 64
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      pts.push([radius * Math.cos(angle), radius * Math.sin(angle), 0])
    }
    return pts
  }, [radius])

  return (
    <Line points={points} color={color} lineWidth={1} dashed dashSize={0.05} gapSize={0.05} transparent opacity={opacity} />
  )
}

/**
 * Dashed shell that fades in while a subagent is materializing. Opacity is
 * driven imperatively from the parent's `useFrame` clock (via `shellRef`),
 * not from a React prop, so the fade-in animates every frame without
 * re-rendering.
 */
function MaterializingShell({ color, shellRef }: { color: THREE.Color | string; shellRef: RefObject<ComponentRef<typeof Line> | null> }) {
  const points = useMemo(() => {
    const pts: [number, number, number][] = []
    const segments = 32
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      pts.push([MOON_SHELL_RADIUS * Math.cos(angle), MOON_SHELL_RADIUS * Math.sin(angle), 0])
    }
    return pts
  }, [])

  return (
    <Line ref={shellRef} points={points} color={color} lineWidth={1} dashed dashSize={0.03} gapSize={0.03} transparent opacity={0} />
  )
}

export function Moon({ subagent, hue, parentX, parentY, orbitRadius, phase }: MoonProps) {
  const visuals = useMemo(() => moonVisuals(subagent.state), [subagent.state])
  const color = useMemo(() => oklchTagColor(hue), [hue])
  const coreColor = subagent.state === 'needs_input' ? WHITE : visuals.dimmed ? GREY : color

  const orbitGroupRef = useRef<THREE.Group>(null!)
  const bodyGroupRef = useRef<THREE.Group>(null!)
  const tickGroupRef = useRef<THREE.Group>(null!)
  const rippleRef = useRef<THREE.Mesh>(null!)
  const shellRef = useRef<ComponentRef<typeof Line>>(null)
  const shellProgress = useRef(0)
  const rippleElapsed = useRef(0)
  const angle = useRef(phase)

  useFrame((_state, delta) => {
    angle.current += (ORBIT_ANGULAR_SPEED / Math.max(orbitRadius, 0.01)) * delta
    const localX = orbitRadius * Math.cos(angle.current)
    const localY = orbitRadius * Math.sin(angle.current)
    if (bodyGroupRef.current) bodyGroupRef.current.position.set(localX, localY, 0)

    if (visuals.tickSpin > 0 && tickGroupRef.current) {
      tickGroupRef.current.rotation.z += visuals.tickSpin * delta
    }

    if (visuals.rippleActive) {
      rippleElapsed.current = (rippleElapsed.current + delta) % MOON_RIPPLE_DURATION_SEC
      const progress = rippleElapsed.current / MOON_RIPPLE_DURATION_SEC
      if (rippleRef.current) {
        rippleRef.current.scale.setScalar(MOON_RIPPLE_MIN_SCALE + progress * (MOON_RIPPLE_MAX_SCALE - MOON_RIPPLE_MIN_SCALE))
        const mat = rippleRef.current.material as THREE.MeshBasicMaterial
        mat.opacity = 1 - progress
      }
    } else {
      rippleElapsed.current = 0
    }

    if (visuals.dashedShell) {
      shellProgress.current = Math.min(1, shellProgress.current + delta / MOON_MATERIALIZE_FADE_IN_SEC)
    } else {
      shellProgress.current = 0
    }
    if (shellRef.current) {
      shellRef.current.material.opacity = shellProgress.current
    }
  })

  return (
    <group ref={orbitGroupRef} position={[parentX, parentY, 0]}>
      <OrbitRing radius={orbitRadius} color={color} opacity={visuals.trailOpacity} />

      <group ref={bodyGroupRef}>
        {visuals.dashedShell && <MaterializingShell color={color} shellRef={shellRef} />}

        <group ref={tickGroupRef}>
          <TickRing
            count={MOON_TICK_COUNT}
            radius={MOON_TICK_RADIUS}
            width={MOON_TICK_WIDTH}
            length={MOON_TICK_LENGTH}
            color={visuals.dimmed ? GREY : color}
          />
        </group>

        <mesh>
          <circleGeometry args={[MOON_CORE_RADIUS, 20]} />
          <meshBasicMaterial color={coreColor} transparent opacity={visuals.coreOpacity} />
        </mesh>

        {visuals.rippleActive && (
          <mesh ref={rippleRef}>
            <ringGeometry args={[MOON_RIPPLE_INNER, MOON_RIPPLE_OUTER, 32]} />
            <meshBasicMaterial color={WHITE} transparent opacity={1} depthWrite={false} />
          </mesh>
        )}
      </group>
    </group>
  )
}
