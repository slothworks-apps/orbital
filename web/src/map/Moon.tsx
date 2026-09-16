import { useEffect, useMemo, useRef, type ComponentRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { Subagent } from '../lib/types'
import {
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
import {
  MOON_STATES,
  advanceStateMix,
  advanceTween,
  blendMoon,
  createMoonBlend,
  advancePointTween,
  useHueTween,
  usePointTween,
  useStateMix,
} from './transition'
import { glowTexture } from './textures'
import { oklchTagColor, setOklchTagColor, TickRing } from './Planet'

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
 *
 * STATE CHANGES CROSSFADE — see `transition.ts` and the same note at the top
 * of `Planet.tsx`: every layer stays mounted, materials are owned by the
 * component and written from the frame loop, and sizes are driven by SCALING
 * unit geometry rather than by rebuilding geometry per frame.
 */

/** 1px rim straddling the disc edge (`border:1px solid hue/<x>`). */
const RIM_WIDTH = 0.01

/** Dark disc fills: `oklch(30% .05 220)` working/materializing, `oklch(28% .05 220)` idle/needs-input. */
const DISC_COLOR = oklchTagColor(220, 0.3, 0.05)
const DISC_COLOR_IDLE = oklchTagColor(220, 0.28, 0.05)
/** Ended moon: flat `oklch(16% .01 230)` like the ended planet body. */
const DISC_COLOR_ENDED = oklchTagColor(230, 0.16, 0.01)

/** Per-state disc fill, summed by weight so the fill eases across a state change. */
const DISC_COLORS: Record<Subagent['state'], THREE.Color> = {
  materializing: DISC_COLOR,
  working: DISC_COLOR,
  idle: DISC_COLOR_IDLE,
  needs_input: DISC_COLOR_IDLE,
  ended: DISC_COLOR_ENDED,
}

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
const GREY_COLOR = new THREE.Color(GREY)
const WHITE_COLOR = new THREE.Color(WHITE)

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

/** Circle outline used for the orbit trail, the materializing shell and its expanding ring. */
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

type LineHandle = ComponentRef<typeof Line>

interface MoonMaterials {
  glow: THREE.MeshBasicMaterial
  disc: THREE.MeshBasicMaterial
  rim: THREE.MeshBasicMaterial
  core: THREE.MeshBasicMaterial
  ripple: THREE.MeshBasicMaterial
  ticks: THREE.MeshBasicMaterial
  matFill: THREE.MeshBasicMaterial
}

/** One material set per moon, created once and mutated by the frame loop. */
function useMoonMaterials(): MoonMaterials {
  const materials = useMemo<MoonMaterials>(() => {
    const soft = (color?: THREE.Color | string, map?: THREE.Texture | null) => {
      const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
      if (color !== undefined) material.color.set(color)
      if (map) material.map = map
      return material
    }
    return {
      glow: soft(undefined, glowTexture()),
      disc: soft(),
      rim: soft(),
      core: soft(),
      ripple: soft(WHITE),
      ticks: soft(),
      matFill: soft(DISC_COLOR),
    }
  }, [])

  useEffect(
    () => () => {
      for (const material of Object.values(materials)) material.dispose()
    },
    [materials]
  )

  return materials
}

export function Moon({ subagent, hue, parentX, parentY, orbitRadius, phase }: MoonProps) {
  const mix = useStateMix(MOON_STATES, subagent.state)
  const hueTween = useHueTween(hue)
  const materials = useMoonMaterials()
  const hasGlowTexture = glowTexture() !== null

  /**
   * The disc + rim are drawn as unit geometry inside a group scaled to the
   * blended radius, so interpolating the size never rebuilds a geometry. The
   * rim's 1px band is normalised against the TARGET radius, which makes it
   * exact at rest (where the scale equals that radius) and lets it breathe by
   * a sub-pixel fraction only while a transition is actually running.
   */
  const targetDiscRadius = useMemo(() => moonVisuals(subagent.state).discRadius, [subagent.state])
  const rimInner = 1 - RIM_WIDTH / 2 / targetDiscRadius
  const rimOuter = 1 + RIM_WIDTH / 2 / targetDiscRadius

  const trailPoints = useMemo(() => circlePoints(orbitRadius, 64), [orbitRadius])

  // A moon is positioned from its parent planet, so it has to walk the same
  // path at the same pace — otherwise a retagged session leaves its moons
  // behind and they snap across afterwards.
  const parentMove = usePointTween(parentX, parentY)

  const parentGroupRef = useRef<THREE.Group>(null)
  const bodyGroupRef = useRef<THREE.Group>(null!)
  const tickGroupRef = useRef<THREE.Group>(null!)
  const discGroupRef = useRef<THREE.Group>(null!)
  const glowRef = useRef<THREE.Mesh>(null!)
  const coreRef = useRef<THREE.Mesh>(null!)
  const rippleRef = useRef<THREE.Mesh>(null!)
  const shellGroupRef = useRef<THREE.Group>(null)
  const shellLineRef = useRef<LineHandle>(null)
  const matRingRef = useRef<LineHandle>(null)
  const trailRef = useRef<LineHandle>(null)
  const matElapsed = useRef(0)
  const rippleElapsed = useRef(0)
  /** Integrated rather than read off the clock: the blink's period is itself interpolating. */
  const corePhase = useRef(0)
  const hueColor = useRef(new THREE.Color())
  const blendRef = useRef(blendMoon(mix.weights, createMoonBlend()))
  const settled = useRef(false)
  // Seeded from the `phase` prop once on mount, then advanced every frame in
  // useFrame — this is the moon's own running angle, not `phase` re-read
  // each render. `phase` only decides WHERE on the orbit each moon starts
  // (so multiple moons around one planet don't all launch from the same
  // point); it intentionally has no effect after the first render.
  const angle = useRef(phase)

  const applyState = () => {
    const w = mix.weights
    const b = blendRef.current
    const hueC = setOklchTagColor(hueColor.current, hueTween.value)
    const solid = 1 - b.materializing

    // 1f: the needs-input moon's glow is the white `0 0 10px #fff` on its core;
    // every other state glows in the tag hue off the disc.
    materials.glow.color.copy(hueC).lerp(WHITE_COLOR, w.needs_input)
    materials.glow.opacity = b.glowOpacity
    materials.glow.visible = hasGlowTexture && b.glowOpacity > 0.001 && b.glowSize > 0
    if (glowRef.current) glowRef.current.scale.setScalar(b.glowSize)

    let r = 0
    let g = 0
    let bl = 0
    for (const state of MOON_STATES) {
      const weight = w[state]
      if (weight === 0) continue
      const c = DISC_COLORS[state]
      r += weight * c.r
      g += weight * c.g
      bl += weight * c.b
    }
    materials.disc.color.setRGB(r, g, bl)
    materials.disc.opacity = solid * b.dim
    materials.disc.visible = materials.disc.opacity > 0.001

    materials.rim.color.copy(hueC).lerp(GREY_COLOR, w.ended)
    materials.rim.opacity = b.rimOpacity * solid * b.dim
    materials.rim.visible = materials.rim.opacity > 0.001
    if (discGroupRef.current) discGroupRef.current.scale.setScalar(b.discRadius)

    materials.ticks.color.copy(hueC)
    materials.ticks.opacity = w.working * MOON_TICK_OPACITY
    materials.ticks.visible = materials.ticks.opacity > 0.001

    materials.core.color.copy(hueC).lerp(WHITE_COLOR, w.needs_input)
    if (coreRef.current) coreRef.current.scale.setScalar(b.coreRadius)

    if (trailRef.current) {
      trailRef.current.material.color.copy(hueC).lerp(GREY_COLOR, w.ended)
      trailRef.current.material.opacity = b.trailOpacity
    }
    if (shellLineRef.current) shellLineRef.current.material.color.copy(hueC)
    if (matRingRef.current) matRingRef.current.material.color.copy(hueC)
  }

  useFrame((_, delta) => {
    if (advancePointTween(parentMove, delta) && parentGroupRef.current) {
      parentGroupRef.current.position.set(parentMove.x.value, parentMove.y.value, 0)
    }

    angle.current += (ORBIT_ANGULAR_SPEED / Math.max(orbitRadius, 0.01)) * delta
    const localX = orbitRadius * Math.cos(angle.current)
    const localY = orbitRadius * Math.sin(angle.current)
    if (bodyGroupRef.current) bodyGroupRef.current.position.set(localX, localY, 0)

    const mixMoved = advanceStateMix(mix, delta)
    const hueMoved = advanceTween(hueTween, delta)
    const b = blendRef.current
    if (mixMoved) blendMoon(mix.weights, b)
    if (mixMoved || hueMoved || !settled.current) applyState()
    settled.current = !(mixMoved || hueMoved)

    if (b.tickSpin > 0 && tickGroupRef.current) {
      tickGroupRef.current.rotation.z += b.tickSpin * delta
    }

    corePhase.current += b.corePulseSec > 0 ? delta / b.corePulseSec : 0
    const blink = b.corePulse > 0 ? 1 - BLINK_DEPTH * b.corePulse * oscillate(corePhase.current, 1) : 1
    materials.core.opacity = b.coreOpacity * blink * b.dim
    materials.core.visible = materials.core.opacity > 0.001 && b.coreRadius > 0

    if (b.ripple > 0.001) {
      rippleElapsed.current = (rippleElapsed.current + delta) % MOON_RIPPLE_DURATION_SEC
      const progress = easeOut(rippleElapsed.current / MOON_RIPPLE_DURATION_SEC)
      if (rippleRef.current) rippleRef.current.scale.setScalar(1 + progress * (MOON_RIPPLE_MAX_SCALE - 1))
      materials.ripple.opacity = MOON_RIPPLE_START_OPACITY * (1 - progress) * b.ripple
      materials.ripple.visible = true
    } else {
      rippleElapsed.current = 0
      materials.ripple.visible = false
    }

    // The materializing look is a crossfade, not a blend: the dashed shell and
    // its expanding ring keep their own animation and are scaled in and out by
    // `b.materializing` against the solid disc.
    if (b.materializing > 0.001) {
      matElapsed.current += delta
      // `orb-mat 1.8s ease-in-out`: opacity .3 ↔ .95, scale .85 ↔ 1.
      const breath = oscillate(matElapsed.current, MAT_SHELL_SEC)
      const shellOpacity = MAT_SHELL_MIN_OPACITY + (MAT_SHELL_MAX_OPACITY - MAT_SHELL_MIN_OPACITY) * breath
      const shellScale = MAT_SHELL_MIN_SCALE + (MAT_SHELL_MAX_SCALE - MAT_SHELL_MIN_SCALE) * breath
      if (shellGroupRef.current) shellGroupRef.current.scale.setScalar(shellScale)
      if (shellLineRef.current) {
        shellLineRef.current.material.opacity = shellOpacity * 0.9 * b.materializing
        shellLineRef.current.visible = true
      }
      materials.matFill.opacity = shellOpacity * MAT_FILL_ALPHA * b.materializing
      materials.matFill.visible = true
      // `orb-matring 1.8s ease-out`: scale .6 → 2, opacity .8 → 0.
      const ringProgress = easeOut((matElapsed.current % MAT_RING_SEC) / MAT_RING_SEC)
      if (matRingRef.current) {
        matRingRef.current.scale.setScalar(
          MAT_RING_MIN_SCALE + ringProgress * (MAT_RING_MAX_SCALE - MAT_RING_MIN_SCALE)
        )
        matRingRef.current.material.opacity = MAT_RING_START_OPACITY * (1 - ringProgress) * b.materializing
        matRingRef.current.visible = true
      }
    } else {
      matElapsed.current = 0
      materials.matFill.visible = false
      if (shellLineRef.current) shellLineRef.current.visible = false
      if (matRingRef.current) matRingRef.current.visible = false
    }
  })

  return (
    // The tween's current value, NOT the props — see `usePointTween`.
    <group ref={parentGroupRef} position={[parentMove.x.value, parentMove.y.value, 0]}>
      {/* Dashed orbit ring traced once around the parent planet's position (`1px dashed hue/.22` in 1f). */}
      <Line
        ref={trailRef}
        points={trailPoints}
        lineWidth={1}
        dashed
        dashSize={0.05}
        gapSize={0.05}
        transparent
        opacity={0}
      />

      <group ref={bodyGroupRef}>
        {hasGlowTexture && (
          <mesh ref={glowRef} position={[0, 0, -0.01]} material={materials.glow}>
            <planeGeometry args={[1, 1]} />
          </mesh>
        )}

        <group ref={discGroupRef}>
          <mesh material={materials.disc}>
            <circleGeometry args={[1, 24]} />
          </mesh>
          <mesh material={materials.rim}>
            <ringGeometry args={[rimInner, rimOuter, 32]} />
          </mesh>
        </group>

        <group ref={shellGroupRef}>
          <mesh material={materials.matFill}>
            <circleGeometry args={[MAT_RADIUS, 24]} />
          </mesh>
          <Line
            ref={shellLineRef}
            points={MAT_SHELL_POINTS}
            lineWidth={1}
            dashed
            dashSize={0.03}
            gapSize={0.03}
            transparent
            opacity={0}
          />
        </group>

        <Line ref={matRingRef} points={MAT_RING_POINTS} lineWidth={1} transparent opacity={0} />

        <group ref={tickGroupRef}>
          <TickRing
            count={MOON_TICK_COUNT}
            radius={MOON_TICK_RADIUS}
            widthDeg={MOON_TICK_WIDTH_DEG}
            length={MOON_TICK_LENGTH}
            material={materials.ticks}
          />
        </group>

        {/* Unit circle scaled to the blended core radius — see Planet.tsx. */}
        <mesh ref={coreRef} position={[0, 0, 0.01]} material={materials.core}>
          <circleGeometry args={[1, 20]} />
        </mesh>

        <mesh ref={rippleRef} position={[0, 0, 0.02]} material={materials.ripple}>
          <ringGeometry args={[MOON_RIPPLE_INNER, MOON_RIPPLE_OUTER, 32]} />
        </mesh>
      </group>
    </group>
  )
}
