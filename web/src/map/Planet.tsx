import { useEffect, useLayoutEffect, useMemo, useRef, type ComponentRef, type RefObject } from 'react'
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
  truncateLabel,
} from './visuals'
import {
  PLANET_STATES,
  PLANET_TICK_LAYERS,
  RETICLE_ENTER_MS,
  RETICLE_EXIT_MS,
  STATE_TRANSITION_MS,
  advanceStateMix,
  advanceTween,
  blendPlanet,
  createPlanetBlend,
  prefersReducedMotion,
  stackAlphas,
  tickLayerWeight,
  useFadeTween,
  useHueTween,
  useLingering,
  useStateMix,
} from './transition'
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
 *
 * STATE CHANGES CROSSFADE (see `transition.ts`). The consequence for this
 * file: every state-dependent layer is mounted ALL the time and its
 * appearance is written onto a component-owned material inside `useFrame`,
 * rather than being mounted/unmounted by React and configured through JSX
 * props. Two rules fall out of that and must hold:
 *
 *   1. Materials are created once per planet (`usePlanetMaterials`) and
 *      handed to meshes via the `material` prop. Nothing passes `color` or
 *      `opacity` as a JSX prop on a state-dependent layer — R3F would
 *      re-apply it on the next render and stamp over the frame loop's value.
 *   2. The frame loop allocates nothing. Colours are mutated in place, the
 *      blend writes into a hoisted object, and a planet at rest does no
 *      blend work at all (`advanceStateMix` returns false immediately).
 *
 * Layers that would otherwise be invisible are switched off with
 * `material.visible`, so an idle planet costs no more draw calls than before.
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

/**
 * Selection reticle (1f, "Selected": `Any state + slow dashed reticle and
 * corner brackets`). The export's markup is a dashed ring at `inset:-42px`
 * carrying `animation: orb-spin 40s linear infinite`, followed by four
 * `10px` `1.5px solid #fff` corner spans at `±50px` which are SIBLINGS of
 * that ring and carry no animation of their own — so the ring turns and the
 * brackets stand still. They are therefore built as two groups here, and
 * only the ring group is rotated.
 */
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

/** Scratch colours for the per-frame hue → grey / hue → white mixes. Module-level and used synchronously, so one pair serves every planet without allocating. */
const GREY_COLOR = new THREE.Color(GREY)
const WHITE_COLOR = new THREE.Color(WHITE)

/**
 * The label is anchored by its TOP edge, which is what the export measures:
 * `top: calc(100% + 34px)` sits the text 34px under the body box, not its
 * centre. That also keeps the gap honest at every zoom — `<Html>` draws at a
 * fixed 11px, so half a line of text is a different number of world units at
 * every zoom level, and a centred anchor would let the gap drift with it.
 *
 * A selected planet draws corner brackets at ±100px, and the resting label
 * runs straight through the bottom edge of that square. So while the reticle
 * is up the label slides clear of it, on the reticle's own fade, and returns
 * to the export's position when the selection goes.
 */
const LABEL_TOP_REST_Y = -(BODY_RADIUS + px(34))
const LABEL_TOP_SELECTED_Y = -(BRACKET_INSET + px(8))
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

/**
 * The three body fills (flat ended / idle gradient / working gradient) are
 * coplanar and all transparent, which leaves three.js no stable way to order
 * them. Tiny z steps behind `BODY_Z` fix the painting order back-to-front
 * without moving the body off the border and tick rings that sit at BODY_Z.
 */
const BODY_ENDED_Z = -0.003
const BODY_IDLE_Z = -0.002
const BODY_WORKING_Z = -0.001

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
 * Writes the app's `tagColor(hue)` (`oklch(<lightness> <chroma> <hue>)`) into
 * an existing THREE.Color. three@0.162's `Color.setStyle` does not parse
 * `oklch()` strings, so the OKLCH -> linear-sRGB math (Björn Ottosson's
 * OKLab) is inlined here rather than passing the CSS string straight into a
 * material.
 *
 * Mutating form: the hue tween recomputes this every frame while a session is
 * being retagged, and a planet that allocated a Color per frame would hand
 * the GC 50+ objects a frame across the map.
 *
 * The matrices below produce LINEAR sRGB primaries — three's default
 * working color space — so the result is loaded via
 * `THREE.LinearSRGBColorSpace` (a no-op copy). Loading it as
 * `THREE.SRGBColorSpace` instead would tell three the values are still
 * gamma-encoded and re-linearize them, darkening every color and shifting
 * its hue (pinned by `colors.test.ts` against independently computed CSS
 * Color 4 reference hex values).
 */
export function setOklchTagColor(
  target: THREE.Color,
  hue: number,
  lightness = 0.8,
  chroma = 0.13
): THREE.Color {
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

  target.setRGB(
    THREE.MathUtils.clamp(r, 0, 1),
    THREE.MathUtils.clamp(g, 0, 1),
    THREE.MathUtils.clamp(bl, 0, 1),
    THREE.LinearSRGBColorSpace
  )
  return target
}

/** Allocating form of `setOklchTagColor`, for one-off/static colours. */
export function oklchTagColor(hue: number, lightness = 0.8, chroma = 0.13): THREE.Color {
  return setOklchTagColor(new THREE.Color(), hue, lightness, chroma)
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
 *
 * The material is supplied by the caller rather than declared here: a tick
 * ring is one of the crossfaded layers, so its owner drives its opacity and
 * colour from the frame loop.
 */
export function TickRing({
  count,
  radius,
  widthDeg,
  length,
  material,
}: {
  count: number
  radius: number
  widthDeg: number
  length: number
  material: THREE.Material
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
    <instancedMesh ref={meshRef} material={material} args={[undefined, undefined, count]}>
      <planeGeometry args={[width, length]} />
    </instancedMesh>
  )
}

/**
 * The thin inner instrument ring:
 * `repeating-conic-gradient(hue/.5 0 60deg, transparent 60deg 90deg)` masked
 * to a 2px band at inset -14, spinning `orb-spin 60s linear infinite reverse`
 * (artboard 1f / 1a / 2d). Four 60° arcs with 30° gaps, counter-rotating
 * against the tick ring.
 *
 * All four arcs share ONE material, so the frame loop fades the ring in and
 * out with a single write.
 */
export function ArcRing({ material }: { material: THREE.Material }) {
  return (
    <>
      {Array.from({ length: ARC_COUNT }, (_, i) => (
        <mesh key={i} material={material}>
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
        </mesh>
      ))}
    </>
  )
}

/**
 * The four corner brackets' polylines. Module-level so the arrays keep a
 * stable reference: a fresh array every render makes drei's `<Line>` tear
 * down and rebuild its live geometry/material, and these points never change.
 */
const BRACKET_SIGNS: readonly (readonly [number, number])[] = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
]

const BRACKET_POINTS: [number, number, number][][] = BRACKET_SIGNS.map(([signX, signY]) => {
  const cx = signX * BRACKET_INSET
  const cy = signY * BRACKET_INSET
  return [
    [cx - signX * BRACKET_LENGTH, cy, 0],
    [cx, cy, 0],
    [cx, cy - signY * BRACKET_LENGTH, 0],
  ] as [number, number, number][]
})

const RETICLE_RING_POINTS: [number, number, number][] = (() => {
  const pts: [number, number, number][] = []
  const segments = 96
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    pts.push([RETICLE_RADIUS * Math.cos(angle), RETICLE_RADIUS * Math.sin(angle), 0])
  }
  return pts
})()

type LineHandle = ComponentRef<typeof Line>

/**
 * Selection reticle: the export's slow dashed ring plus four static corner
 * brackets. Only `ringGroupRef` is spun — in the export the brackets are
 * unanimated siblings of the spinning ring, so they hold their corners while
 * the ring turns inside them.
 *
 * Both parts fade with the selection rather than popping, which is why their
 * line materials are handed back to the parent through refs.
 */
function SelectionReticle({
  ringGroupRef,
  ringRef,
  bracketRefs,
}: {
  ringGroupRef: RefObject<THREE.Group | null>
  ringRef: RefObject<LineHandle | null>
  bracketRefs: RefObject<(LineHandle | null)[]>
}) {
  return (
    <group position={[0, 0, RETICLE_Z]}>
      <group ref={ringGroupRef}>
        <Line
          ref={ringRef}
          points={RETICLE_RING_POINTS}
          color={RETICLE_COLOR}
          lineWidth={1}
          dashed
          dashSize={RETICLE_DASH_SIZE}
          gapSize={RETICLE_DASH_GAP}
          transparent
          opacity={0}
        />
      </group>
      {BRACKET_POINTS.map((points, i) => (
        // 1f draws the brackets `1.5px solid #fff`, opaque at rest — only the
        // dashed ring is tinted. They still fade with the selection.
        <Line
          key={i}
          ref={(handle) => {
            bracketRefs.current[i] = handle
          }}
          points={points}
          color={WHITE}
          lineWidth={1.5}
          transparent
          opacity={0}
        />
      ))}
    </group>
  )
}

/** "NEEDS INPUT" pill badge — mono, blinking dot, right of the planet (state sheet artboard 1f). */
function NeedsInputBadge({ innerRef }: { innerRef: RefObject<HTMLSpanElement | null> }) {
  // zIndexRange keeps map text under the z-10 side panels and z-50 dialogs
  // (drei's default range is in the millions).
  return (
    <Html position={[BADGE_OFFSET_X, BADGE_OFFSET_Y, CORE_Z]} zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
      <span
        ref={innerRef}
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
          opacity: 0,
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

interface PlanetMaterials {
  glow: THREE.MeshBasicMaterial
  halo: THREE.MeshBasicMaterial
  arc: THREE.MeshBasicMaterial
  bodyEnded: THREE.MeshBasicMaterial
  bodyIdle: THREE.MeshBasicMaterial
  bodyWorking: THREE.MeshBasicMaterial
  innerShade: THREE.MeshBasicMaterial
  border: THREE.MeshBasicMaterial
  ticks: THREE.MeshBasicMaterial[]
  coreGlowHue: THREE.MeshBasicMaterial
  coreGlowWhite: THREE.MeshBasicMaterial
  core: THREE.MeshBasicMaterial
  ripple: THREE.MeshBasicMaterial
}

/**
 * One material set per planet, created once and mutated by the frame loop.
 * Per-planet rather than shared because every one of these carries that
 * planet's own hue, opacity and visibility.
 */
function usePlanetMaterials(): PlanetMaterials {
  const materials = useMemo<PlanetMaterials>(() => {
    // `MeshBasicMaterial`'s constructor warns on an explicitly-undefined
    // parameter, so optional ones are only set when they exist (textures are
    // null wherever no 2D canvas is available).
    const soft = (color?: THREE.Color | string, map?: THREE.Texture | null) => {
      const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
      if (color !== undefined) material.color.set(color)
      if (map) material.map = map
      return material
    }
    const glowMap = glowTexture()
    const core = new THREE.MeshBasicMaterial({ transparent: true })
    return {
      glow: soft(undefined, glowMap),
      halo: soft(),
      arc: soft(),
      bodyEnded: soft(BODY_ENDED_COLOR),
      bodyIdle: soft(undefined, bodyIdleTexture()),
      bodyWorking: soft(undefined, bodyTexture()),
      innerShade: soft(BLACK),
      border: soft(),
      ticks: PLANET_TICK_LAYERS.map((layer) => soft(layer.grey ? GREY : undefined)),
      coreGlowHue: soft(undefined, glowMap),
      coreGlowWhite: soft(WHITE, glowMap),
      core,
      ripple: soft(WHITE),
    }
  }, [])

  useEffect(
    () => () => {
      for (const value of Object.values(materials)) {
        if (Array.isArray(value)) value.forEach((m) => m.dispose())
        else value.dispose()
      }
    },
    [materials]
  )

  return materials
}

export function Planet({ session, hue, x, y, scale, selected, onClick }: PlanetProps) {
  const mix = useStateMix(PLANET_STATES, session.status)
  const hueTween = useHueTween(hue)
  const reticleFade = useFadeTween(selected, RETICLE_ENTER_MS, RETICLE_EXIT_MS)
  const materials = usePlanetMaterials()

  // Textures are process-wide singletons; null only where no 2D canvas exists
  // (jsdom), in which case the gradient bodies are skipped and the flat fill
  // stands in — same fallback as before.
  const hasBodyTextures = bodyTexture() !== null && bodyIdleTexture() !== null
  const hasGlowTexture = glowTexture() !== null

  // Kept mounted through their fade-out, so deselecting and leaving
  // needs-input dissolve instead of being yanked out of the tree by React.
  const reticleMounted = useLingering(selected, RETICLE_EXIT_MS)
  const badgeMounted = useLingering(session.status === 'needs_input', STATE_TRANSITION_MS)
  const reduced = prefersReducedMotion()

  const tickGroupRef = useRef<THREE.Group>(null!)
  const arcGroupRef = useRef<THREE.Group>(null!)
  const coreRef = useRef<THREE.Mesh>(null!)
  const rippleRef = useRef<THREE.Mesh>(null!)
  const reticleGroupRef = useRef<THREE.Group>(null)
  const reticleRingRef = useRef<LineHandle | null>(null)
  const bracketRefs = useRef<(LineHandle | null)[]>([])
  const badgeRef = useRef<HTMLSpanElement | null>(null)
  const labelGroupRef = useRef<THREE.Group>(null)
  const rippleElapsed = useRef(0)
  /**
   * The blink's own phase, advanced by `delta / period` rather than read off
   * the global clock: the period itself is interpolating (2.4s working ⇄ 1.2s
   * needs-input), and `cos(t / p)` with a changing `p` jumps whenever `p`
   * moves. Integrating the phase keeps the blink continuous through the
   * transition.
   */
  const corePhase = useRef(0)
  const bodyAlphas = useRef<number[]>([0, 0, 0])
  const hueColor = useRef(new THREE.Color())
  /** Seeded from the table so a planet is correct on its very first frame. */
  const blendRef = useRef(blendPlanet(mix.weights, createPlanetBlend()))
  /** False until the settled values have been written once after a transition ends. */
  const settled = useRef(false)

  const dimmedLabel = session.status === 'ended'

  /**
   * Writes everything that depends only on the state weights and the hue.
   * Called on any frame where either moved, plus the one frame after they
   * stop — never on a resting planet.
   */
  const applyState = () => {
    const w = mix.weights
    const b = blendRef.current
    const hueC = setOklchTagColor(hueColor.current, hueTween.value)
    const idleShare = w.idle + w.needs_input

    materials.glow.color.copy(hueC)
    materials.glow.opacity = w.working * GLOW_OPACITY
    materials.glow.visible = hasGlowTexture && materials.glow.opacity > 0.001

    materials.halo.color.copy(hueC)

    materials.arc.color.copy(hueC)
    materials.arc.opacity = b.arcOpacity
    materials.arc.visible = b.arcOpacity > 0.001

    if (hasBodyTextures) {
      // Bottom-to-top: flat ended fill, idle gradient, working gradient.
      const alphas = stackAlphas([w.ended, idleShare, w.working], bodyAlphas.current)
      materials.bodyEnded.opacity = alphas[0] * DIMMED_OPACITY
      materials.bodyEnded.visible = alphas[0] > 0.001
      materials.bodyIdle.opacity = alphas[1]
      materials.bodyIdle.visible = alphas[1] > 0.001
      materials.bodyWorking.opacity = alphas[2]
      materials.bodyWorking.visible = alphas[2] > 0.001
    } else {
      materials.bodyEnded.opacity = b.dim
      materials.bodyEnded.visible = true
      materials.bodyIdle.visible = false
      materials.bodyWorking.visible = false
    }

    materials.innerShade.opacity = w.working * INNER_SHADE_OPACITY
    materials.innerShade.visible = materials.innerShade.opacity > 0.001

    materials.border.color.copy(hueC).lerp(GREY_COLOR, w.ended)
    materials.border.opacity =
      (w.working * BORDER_OPACITY_ACTIVE +
        idleShare * BORDER_OPACITY_IDLE +
        w.ended * BORDER_OPACITY_ENDED) *
      b.dim

    // Crossfade: each distinct tick ring is drawn at the summed weight of the
    // states that wear it. Counts (60/45/30) cannot be interpolated, so the
    // rings dissolve into one another instead.
    PLANET_TICK_LAYERS.forEach((layer, i) => {
      const material = materials.ticks[i]
      const weight = tickLayerWeight(layer, w)
      material.opacity = weight * layer.opacity * b.dim
      material.visible = material.opacity > 0.001
      if (!layer.grey) material.color.copy(hueC)
    })

    materials.coreGlowHue.color.copy(hueC)
    materials.coreGlowHue.opacity = w.needs_input * CORE_GLOW_HUE_OPACITY
    materials.coreGlowHue.visible = hasGlowTexture && materials.coreGlowHue.opacity > 0.001
    materials.coreGlowWhite.opacity = w.needs_input * CORE_GLOW_WHITE_OPACITY
    materials.coreGlowWhite.visible = hasGlowTexture && materials.coreGlowWhite.opacity > 0.001

    materials.core.color.copy(hueC).lerp(WHITE_COLOR, w.needs_input)
    if (coreRef.current) coreRef.current.scale.setScalar(b.coreRadius)

    if (badgeRef.current) badgeRef.current.style.opacity = String(w.needs_input)
  }

  useFrame((state, delta) => {
    const mixMoved = advanceStateMix(mix, delta)
    const hueMoved = advanceTween(hueTween, delta)
    const b = blendRef.current
    if (mixMoved) blendPlanet(mix.weights, b)
    if (mixMoved || hueMoved || !settled.current) applyState()
    settled.current = !(mixMoved || hueMoved)

    if (b.tickSpin !== 0 && tickGroupRef.current) {
      tickGroupRef.current.rotation.z += b.tickSpin * delta
    }

    if (b.arcSpin !== 0 && arcGroupRef.current) {
      arcGroupRef.current.rotation.z += b.arcSpin * delta
    }

    // `orb-blink`: opacity 1 → .3 → 1 over corePulseSec (a blink, not a scale pulse).
    corePhase.current += b.corePulseSec > 0 ? delta / b.corePulseSec : 0
    const blink = b.corePulse > 0 ? 1 - BLINK_DEPTH * b.corePulse * oscillate(corePhase.current, 1) : 1
    materials.core.opacity = b.coreOpacity * blink * b.dim
    materials.core.visible = materials.core.opacity > 0.001

    // `orb-ring`: opacity ×.55 → ×1 → ×.55 over 2.4s, faded in by haloBreath.
    const breath =
      1 - b.haloBreath * (1 - HALO_BREATH_MIN) * (1 - oscillate(state.clock.elapsedTime, HALO_BREATH_SEC))
    materials.halo.opacity = b.haloOpacity * breath
    materials.halo.visible = materials.halo.opacity > 0.001

    if (b.ripple > 0.001) {
      rippleElapsed.current = (rippleElapsed.current + delta) % RIPPLE_DURATION_SEC
      const progress = easeOut(rippleElapsed.current / RIPPLE_DURATION_SEC)
      if (rippleRef.current) rippleRef.current.scale.setScalar(1 + progress * (RIPPLE_MAX_SCALE - 1))
      materials.ripple.opacity = RIPPLE_START_OPACITY * (1 - progress) * b.ripple
      materials.ripple.visible = true
    } else {
      rippleElapsed.current = 0
      materials.ripple.visible = false
    }

    if (reticleGroupRef.current) {
      // The export spins the dashed ring (`orb-spin 40s`); the bracket spans
      // are its unanimated siblings and stay put.
      reticleGroupRef.current.rotation.z += RETICLE_SPIN_SPEED * delta
    }
    if (advanceTween(reticleFade, delta) || reticleFade.value > 0) {
      if (reticleRingRef.current) reticleRingRef.current.material.opacity = RETICLE_OPACITY * reticleFade.value
      for (const bracket of bracketRefs.current) {
        if (bracket) bracket.material.opacity = reticleFade.value
      }
      // `<Html>` re-reads its parent's world matrix every frame, so moving the
      // group is all it takes to carry the label with the reticle.
      if (labelGroupRef.current) {
        labelGroupRef.current.position.y =
          LABEL_TOP_REST_Y + (LABEL_TOP_SELECTED_Y - LABEL_TOP_REST_Y) * reticleFade.value
      }
    }
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    onClick?.(session.id)
  }

  return (
    <group position={[x, y, 0]} scale={scale} onClick={onClick ? handleClick : undefined}>
      {hasGlowTexture && (
        <mesh position={[0, 0, HALO_Z]} material={materials.glow}>
          <planeGeometry args={[GLOW_SIZE, GLOW_SIZE]} />
        </mesh>
      )}

      <mesh position={[0, 0, HALO_Z]} material={materials.halo}>
        <ringGeometry args={[HALO_RING_INNER, HALO_RING_OUTER, 64]} />
      </mesh>

      <group ref={arcGroupRef} position={[0, 0, HALO_Z]}>
        <ArcRing material={materials.arc} />
      </group>

      <mesh position={[0, 0, BODY_ENDED_Z]} material={materials.bodyEnded}>
        <circleGeometry args={[BODY_RADIUS, 48]} />
      </mesh>
      {hasBodyTextures && (
        <>
          <mesh position={[0, 0, BODY_IDLE_Z]} material={materials.bodyIdle}>
            <circleGeometry args={[BODY_RADIUS, 48]} />
          </mesh>
          <mesh position={[0, 0, BODY_WORKING_Z]} material={materials.bodyWorking}>
            <circleGeometry args={[BODY_RADIUS, 48]} />
          </mesh>
        </>
      )}

      <mesh position={[0, 0, BODY_Z]} material={materials.innerShade}>
        <ringGeometry args={[INNER_SHADE_INNER, INNER_SHADE_OUTER, 48]} />
      </mesh>

      <mesh position={[0, 0, BODY_Z]} material={materials.border}>
        <ringGeometry args={[BORDER_INNER, BORDER_OUTER, 64]} />
      </mesh>

      <group ref={tickGroupRef} position={[0, 0, BODY_Z]}>
        {PLANET_TICK_LAYERS.map((layer, i) => (
          <TickRing
            key={layer.count}
            count={layer.count}
            radius={layer.radius}
            widthDeg={layer.widthDeg}
            length={layer.length}
            material={materials.ticks[i]}
          />
        ))}
      </group>

      {hasGlowTexture && (
        <>
          <mesh position={[0, 0, CORE_GLOW_Z]} material={materials.coreGlowHue}>
            <planeGeometry args={[CORE_GLOW_HUE_SIZE, CORE_GLOW_HUE_SIZE]} />
          </mesh>
          <mesh position={[0, 0, CORE_GLOW_Z]} material={materials.coreGlowWhite}>
            <planeGeometry args={[CORE_GLOW_WHITE_SIZE, CORE_GLOW_WHITE_SIZE]} />
          </mesh>
        </>
      )}

      {/* Unit circle scaled to the blended core radius: interpolating the
          geometry's own radius would rebuild it every frame. */}
      <mesh ref={coreRef} position={[0, 0, CORE_Z]} material={materials.core}>
        <circleGeometry args={[1, 32]} />
      </mesh>

      <mesh ref={rippleRef} position={[0, 0, RIPPLE_Z]} material={materials.ripple}>
        <ringGeometry args={[RIPPLE_INNER, RIPPLE_OUTER, 48]} />
      </mesh>

      {reticleMounted && (
        <SelectionReticle
          ringGroupRef={reticleGroupRef}
          ringRef={reticleRingRef}
          bracketRefs={bracketRefs}
        />
      )}

      {badgeMounted && <NeedsInputBadge innerRef={badgeRef} />}

      <group ref={labelGroupRef} position={[0, LABEL_TOP_REST_Y, 0]}>
        <Html zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
          <span
            style={{
              // All three are load-bearing. `transform` does not apply to an
              // inline box, and the shift is what centres the label under the
              // planet (the anchor is its top-LEFT corner). `block` rather than
              // `inline-block` because an inline-block sits on a line box and
              // gets baseline-aligned against the wrapper's strut — measured at
              // ~6px of leading pushing the label off its anchor. A block box
              // has no line box above it and starts exactly at the anchor;
              // `max-content` keeps it shrink-to-fit so the -50% is half the
              // text, not half the wrapper.
              display: 'block',
              width: 'max-content',
              transform: 'translateX(-50%)',
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 11,
              letterSpacing: '0.06em',
              color: dimmedLabel ? LABEL_COLOR_DIMMED : LABEL_COLOR_ACTIVE,
              // The label is plain DOM, so its half of the state change is a CSS
              // transition on the same curve — dropped entirely under reduced
              // motion, which an inline style cannot express as a media query.
              transition: reduced ? undefined : `color ${STATE_TRANSITION_MS}ms cubic-bezier(.2,.8,.2,1)`,
              whiteSpace: 'nowrap',
            }}
          >
            {truncateLabel(session.title)}
          </span>
        </Html>
      </group>
    </group>
  )
}
