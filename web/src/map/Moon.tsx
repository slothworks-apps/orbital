import { useMemo, useRef, type ComponentRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { Subagent } from '../lib/types'
import {
  DIMMED_OPACITY,
  MAT_RING_MAX_SCALE,
  MAT_RING_MIN_SCALE,
  MAT_RING_SEC,
  MAT_RING_START_OPACITY,
  MAT_SHELL_MAX_OPACITY,
  MAT_SHELL_MAX_SCALE,
  MAT_SHELL_MIN_OPACITY,
  MAT_SHELL_MIN_SCALE,
  MAT_SHELL_SEC,
  MOON_TICK_COUNT,
  MOON_TICK_LENGTH,
  MOON_TICK_OPACITY,
  MOON_TICK_RADIUS,
  MOON_TICK_WIDTH_DEG,
  easeOut,
  moonVisuals,
  oscillate,
} from './visuals'
import { glowTexture } from './textures'
import { oklchTagColor, TickRing } from './Planet'

/**
 * Small disc orbiting its parent planet, driven purely by props + an
 * internal `useFrame` clock (`orbitRadius`, `phase`). No store/api imports —
 * Task 9 wires this to live `subagent` WS events.
 *
 * BINDING rule: hue paints the rim/core; subagent STATE is carried only by
 * `moonVisuals` (disc size, tick spin, core blink, ripple, dashed
 * materializing shell) plus a white ripple/core for needs-input, never by
 * re-hue-ing.
 *
 * Geometry is transcribed from the state sheet (artboard 1f in
 * `Orbital.dc.html`, "MOONS · SUBAGENTS" row) and the close-up 1c, where a
 * moon is quoted in absolute px next to a 100px planet body → 0.01 units/px.
 */

/** 1px rim straddling the disc edge (`border:1px solid hue/<x>`). */
const RIM_WIDTH = 0.01

/** Dark disc fills: `oklch(30% .05 220)` working/materializing, `oklch(28% .05 220)` idle/needs-input. */
const DISC_COLOR = oklchTagColor(220, 0.3, 0.05)
const DISC_COLOR_IDLE = oklchTagColor(220, 0.28, 0.05)
/** Ended moon: flat `oklch(16% .01 230)` like the ended planet body. */
const DISC_COLOR_ENDED = oklchTagColor(230, 0.16, 0.01)

/** `orb-blink`: opacity 1 → .3 → 1. */
const BLINK_DEPTH = 0.7

/** Needs-input `orb-pulse-out` ripple: inset -4 on the 22px disc → 15px radius, scale 1 → 1.9 over 2.4s. */
const MOON_RIPPLE_MAX_SCALE = 1.9
const MOON_RIPPLE_DURATION_SEC = 2.4
const MOON_RIPPLE_START_OPACITY = 0.9
const MOON_RIPPLE_INNER = 0.14
const MOON_RIPPLE_OUTER = 0.15

/** Materializing shell fill is drawn at `oklch(30% .05 220 / .6)`. */
const MAT_FILL_ALPHA = 0.6
/** Materializing dashed shell + `orb-matring` both sit on the 24px disc edge. */
const MAT_RADIUS = 0.12

/** Angular orbit speed, radians/sec, at orbitRadius = 1 (scaled by 1/radius so closer moons don't look slower). */
const ORBIT_ANGULAR_SPEED = 0.5

/** Ended grey — `rgba(200,215,235)` in the canvas export. */
const GREY = '#c8d7eb'
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

/** Dashed orbit ring traced once around the parent planet's position (`1px dashed hue/.22` in 1f). */
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

/** Circle outline used for the materializing shell and its expanding ring. */
function circlePoints(radius: number, segments: number): [number, number, number][] {
  const pts: [number, number, number][] = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    pts.push([radius * Math.cos(angle), radius * Math.sin(angle), 0])
  }
  return pts
}

/**
 * Module-level so the point arrays keep a stable reference: a fresh array
 * every render makes drei's <Line> tear down and rebuild its live
 * geometry/material, and these circles never change.
 */
const MAT_SHELL_POINTS = circlePoints(MAT_RADIUS, 32)
const MAT_RING_POINTS = circlePoints(MAT_RADIUS, 48)

export function Moon({ subagent, hue, parentX, parentY, orbitRadius, phase }: MoonProps) {
  const visuals = useMemo(() => moonVisuals(subagent.state), [subagent.state])
  const color = useMemo(() => oklchTagColor(hue), [hue])
  const coreColor = subagent.state === 'needs_input' ? WHITE : color
  // 1f: the needs-input moon's glow is the white `0 0 10px #fff` on its core;
  // every other state glows in the tag hue off the disc.
  const glowColor = subagent.state === 'needs_input' ? WHITE : color
  const glowMap = glowTexture()
  const discColor =
    subagent.state === 'ended'
      ? DISC_COLOR_ENDED
      : subagent.state === 'idle' || subagent.state === 'needs_input'
        ? DISC_COLOR_IDLE
        : DISC_COLOR
  const dim = visuals.dimmed ? DIMMED_OPACITY : 1

  const bodyGroupRef = useRef<THREE.Group>(null!)
  const tickGroupRef = useRef<THREE.Group>(null!)
  const coreMaterialRef = useRef<THREE.MeshBasicMaterial>(null!)
  const rippleRef = useRef<THREE.Mesh>(null!)
  const shellGroupRef = useRef<THREE.Group>(null)
  const shellLineRef = useRef<ComponentRef<typeof Line>>(null)
  const shellFillRef = useRef<THREE.Mesh>(null)
  const matRingRef = useRef<ComponentRef<typeof Line>>(null)
  const matElapsed = useRef(0)
  const rippleElapsed = useRef(0)
  // Seeded from the `phase` prop once on mount, then advanced every frame in
  // useFrame — this is the moon's own running angle, not `phase` re-read
  // each render. `phase` only decides WHERE on the orbit each moon starts
  // (so multiple moons around one planet don't all launch from the same
  // point); it intentionally has no effect after the first render.
  const angle = useRef(phase)

  useFrame((state, delta) => {
    angle.current += (ORBIT_ANGULAR_SPEED / Math.max(orbitRadius, 0.01)) * delta
    const localX = orbitRadius * Math.cos(angle.current)
    const localY = orbitRadius * Math.sin(angle.current)
    if (bodyGroupRef.current) bodyGroupRef.current.position.set(localX, localY, 0)

    if (visuals.tickSpin > 0 && tickGroupRef.current) {
      tickGroupRef.current.rotation.z += visuals.tickSpin * delta
    }

    if (coreMaterialRef.current) {
      const blink =
        visuals.corePulse > 0
          ? 1 - BLINK_DEPTH * visuals.corePulse * oscillate(state.clock.elapsedTime, visuals.corePulseSec)
          : 1
      coreMaterialRef.current.opacity = visuals.coreOpacity * blink * dim
    }

    if (visuals.rippleActive) {
      rippleElapsed.current = (rippleElapsed.current + delta) % MOON_RIPPLE_DURATION_SEC
      const progress = easeOut(rippleElapsed.current / MOON_RIPPLE_DURATION_SEC)
      if (rippleRef.current) {
        rippleRef.current.scale.setScalar(1 + progress * (MOON_RIPPLE_MAX_SCALE - 1))
        const mat = rippleRef.current.material as THREE.MeshBasicMaterial
        mat.opacity = MOON_RIPPLE_START_OPACITY * (1 - progress)
      }
    } else {
      rippleElapsed.current = 0
    }

    if (visuals.dashedShell || visuals.matRing) {
      matElapsed.current += delta
      // `orb-mat 1.8s ease-in-out`: opacity .3 ↔ .95, scale .85 ↔ 1.
      const breath = oscillate(matElapsed.current, MAT_SHELL_SEC)
      const shellOpacity = MAT_SHELL_MIN_OPACITY + (MAT_SHELL_MAX_OPACITY - MAT_SHELL_MIN_OPACITY) * breath
      const shellScale = MAT_SHELL_MIN_SCALE + (MAT_SHELL_MAX_SCALE - MAT_SHELL_MIN_SCALE) * breath
      if (shellGroupRef.current) shellGroupRef.current.scale.setScalar(shellScale)
      if (shellLineRef.current) shellLineRef.current.material.opacity = shellOpacity * 0.9
      if (shellFillRef.current) {
        ;(shellFillRef.current.material as THREE.MeshBasicMaterial).opacity = shellOpacity * MAT_FILL_ALPHA
      }
      // `orb-matring 1.8s ease-out`: scale .6 → 2, opacity .8 → 0.
      const ringProgress = easeOut((matElapsed.current % MAT_RING_SEC) / MAT_RING_SEC)
      if (matRingRef.current) {
        matRingRef.current.scale.setScalar(
          MAT_RING_MIN_SCALE + ringProgress * (MAT_RING_MAX_SCALE - MAT_RING_MIN_SCALE)
        )
        matRingRef.current.material.opacity = MAT_RING_START_OPACITY * (1 - ringProgress)
      }
    } else {
      matElapsed.current = 0
    }
  })

  return (
    <group position={[parentX, parentY, 0]}>
      <OrbitRing radius={orbitRadius} color={visuals.dimmed ? GREY : color} opacity={visuals.trailOpacity} />

      <group ref={bodyGroupRef}>
        {visuals.glowOpacity > 0 && glowMap && (
          <mesh position={[0, 0, -0.01]}>
            <planeGeometry args={[visuals.glowSize, visuals.glowSize]} />
            <meshBasicMaterial
              color={glowColor}
              transparent
              opacity={visuals.glowOpacity}
              depthWrite={false}
              map={glowMap}
            />
          </mesh>
        )}

        {visuals.dashedShell ? (
          <group ref={shellGroupRef}>
            <mesh ref={shellFillRef}>
              <circleGeometry args={[MAT_RADIUS, 24]} />
              <meshBasicMaterial color={DISC_COLOR} transparent opacity={MAT_FILL_ALPHA} depthWrite={false} />
            </mesh>
            <Line
              ref={shellLineRef}
              points={MAT_SHELL_POINTS}
              color={color}
              lineWidth={1}
              dashed
              dashSize={0.03}
              gapSize={0.03}
              transparent
              opacity={0}
            />
          </group>
        ) : (
          <>
            <mesh>
              <circleGeometry args={[visuals.discRadius, 24]} />
              <meshBasicMaterial color={discColor} transparent opacity={dim} />
            </mesh>
            {visuals.rimOpacity > 0 && (
              <mesh>
                <ringGeometry args={[visuals.discRadius - RIM_WIDTH / 2, visuals.discRadius + RIM_WIDTH / 2, 32]} />
                <meshBasicMaterial
                  color={visuals.dimmed ? GREY : color}
                  transparent
                  opacity={visuals.rimOpacity * dim}
                  depthWrite={false}
                />
              </mesh>
            )}
          </>
        )}

        {visuals.matRing && (
          <Line
            ref={matRingRef}
            points={MAT_RING_POINTS}
            color={color}
            lineWidth={1}
            transparent
            opacity={MAT_RING_START_OPACITY}
          />
        )}

        {visuals.tickSpin > 0 && (
          <group ref={tickGroupRef}>
            <TickRing
              count={MOON_TICK_COUNT}
              radius={MOON_TICK_RADIUS}
              widthDeg={MOON_TICK_WIDTH_DEG}
              length={MOON_TICK_LENGTH}
              color={color}
              opacity={MOON_TICK_OPACITY}
            />
          </group>
        )}

        {visuals.coreRadius > 0 && (
          <mesh position={[0, 0, 0.01]}>
            <circleGeometry args={[visuals.coreRadius, 20]} />
            <meshBasicMaterial
              ref={coreMaterialRef}
              color={coreColor}
              transparent
              opacity={visuals.coreOpacity * dim}
            />
          </mesh>
        )}

        {visuals.rippleActive && (
          <mesh ref={rippleRef} position={[0, 0, 0.02]}>
            <ringGeometry args={[MOON_RIPPLE_INNER, MOON_RIPPLE_OUTER, 32]} />
            <meshBasicMaterial color={WHITE} transparent opacity={MOON_RIPPLE_START_OPACITY} depthWrite={false} />
          </mesh>
        )}
      </group>
    </group>
  )
}
