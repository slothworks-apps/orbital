import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SessionStatus, Subagent } from '../lib/types'
import { DIMMED_OPACITY, moonVisuals, planetVisuals, type MoonVisuals, type PlanetVisuals } from './visuals'

/**
 * The interpolation layer that sits ON TOP of `visuals.ts`.
 *
 * `visuals.ts` stays what it is: a pure, time-unaware state table transcribed
 * from the design export. Nothing here writes back into it. This module turns
 * "which state is this body in" into "how much of each state is showing right
 * now", so a session going working → idle → ended eases between the export's
 * literal value sets instead of cutting between them in one frame.
 *
 * ## The model: a weight vector, not a pair of endpoints
 *
 * A body's live appearance is a set of weights over the states, summing to 1
 * (`StateMix`). At rest the vector is one-hot and every blended field equals
 * the table's literal value for that state — so nothing about the resting
 * design changes. During a transition the weights ease from wherever they
 * actually were toward the new one-hot target.
 *
 * Expressing it as weights (rather than a from/to pair) is what makes an
 * interrupted transition correct for free: retargeting snapshots the CURRENT
 * weights as the new starting point, so working → idle interrupted at 40% by
 * working → ended continues from that 40% blend instead of snapping back to a
 * pure `idle` and restarting. It also handles three states being partly
 * visible at once, which a from/to pair cannot represent at all.
 *
 * ## Continuous vs crossfade
 *
 * CONTINUOUS (weighted sum — these have a meaningful midpoint):
 *   planet — tickSpin, arcSpin, arcOpacity, corePulse, coreOpacity,
 *            coreRadius, haloOpacity, halo breathing, the `opacity:.6` ended
 *            dim, and (via the caller) border/glow alphas and hue.
 *   moon   — discRadius, rimOpacity, coreRadius, coreOpacity, corePulse,
 *            glowSize, glowOpacity, trailOpacity, tickSpin, dim.
 *
 * CROSSFADE (no midpoint exists — the outgoing and incoming forms are drawn
 * together and their OPACITIES are what interpolate):
 *   planet — the tick ring as a whole: `tickCount` (60 / 45 / 30),
 *            `tickWidthDeg`, and the `tickRadius`/`tickLength` that belong to
 *            that ring's identity. "52.5 ticks" is not a thing, and animating
 *            a tick ring's radius would rebuild its instance matrices every
 *            frame, so the three distinct rings are drawn as separate layers
 *            (`PLANET_TICK_LAYERS`) whose alphas carry the transition.
 *   planet — the body disc: the working gradient, the idle gradient and the
 *            flat ended fill are three different materials, stacked and
 *            composited with `stackAlphas`.
 *   moon   — the materializing look (dashed breathing shell + expanding ring)
 *            against the solid disc + rim. They are different objects, not
 *            different values of one object.
 *
 * `corePulseSec` is neither: a period of 0 means "not pulsing", not "pulsing
 * infinitely fast", so blending it as a plain number would make a core strobe
 * on its way to idle. It is averaged weighted by each state's pulse DEPTH, so
 * a non-pulsing state contributes nothing to the period while `corePulse`
 * fades the blink out.
 *
 * ## Timing
 *
 * Everything is driven from `useFrame` deltas against a wall-clock duration,
 * never a fixed per-frame step, so the transition takes the same time at
 * 30fps and 144fps. Under `prefers-reduced-motion` the weights snap to the
 * target on the next frame — the map stays correct, it just arrives instantly.
 *
 * Nothing here allocates per frame: every function writes into a caller-owned
 * output object, and the callers hoist those.
 */

/**
 * State-change duration, ms. This is the export's own `transition:width .42s
 * cubic-bezier(.2,.8,.2,1)` — the curve and duration the sidebar collapses on
 * and that `SpaceMap`'s HUD already uses (`duration-[420ms]`). It is
 * deliberately longer than `ui/motion.ts`'s 180/140ms open/close pair: those
 * are a surface appearing, this is an object that is already on screen
 * changing what it is, and at modal speed a planet's rings read as a flicker
 * rather than as a change of state.
 */
export const STATE_TRANSITION_MS = 420

/**
 * Selection reticle fade. A selection ring is an affordance acknowledging a
 * click, not an entrance, so it uses the app's short modal pair from
 * `ui/motion.ts` (180ms in / 140ms out) rather than the 420ms state duration —
 * and, like every other exit in the app, it leaves faster than it arrives.
 */
export const RETICLE_ENTER_MS = 180
export const RETICLE_EXIT_MS = 140

// --- easing ---------------------------------------------------------------

/** The app's motion curve, `cubic-bezier(.2,.8,.2,1)` (export + `ui/motion.ts`). */
const EASE_P1X = 0.2
const EASE_P1Y = 0.8
const EASE_P2X = 0.2
const EASE_P2Y = 1

/** One axis of a cubic Bézier with implicit endpoints (0,0) and (1,1). */
function bezierAxis(t: number, p1: number, p2: number): number {
  const u = 1 - t
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
}

/**
 * `cubic-bezier(.2,.8,.2,1)` evaluated at `x` (0…1).
 *
 * The curve is parametric, so x has to be inverted before y can be read.
 * Bisection rather than Newton-Raphson: both x control points are 0.2, which
 * makes dx/dt tiny near t=1 and Newton's step explode there, while bisection
 * on a monotonic x is unconditionally stable. 24 halvings put t within 6e-8,
 * far below a frame's worth of progress.
 */
export function easeMotion(x: number): number {
  if (!(x > 0)) return 0
  if (x >= 1) return 1
  let lo = 0
  let hi = 1
  let t = x
  for (let i = 0; i < 24; i++) {
    t = (lo + hi) / 2
    if (bezierAxis(t, EASE_P1X, EASE_P2X) < x) lo = t
    else hi = t
  }
  return bezierAxis(t, EASE_P1Y, EASE_P2Y)
}

/** True when the user has asked the OS to reduce motion (same probe as `ui/usePresence`). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

// --- state mix ------------------------------------------------------------

export interface StateMix<S extends string> {
  readonly states: readonly S[]
  /** Live weights, summing to 1. One-hot at rest. */
  readonly weights: Record<S, number>
  /** Weights at the moment the current transition started — NOT the previous target. */
  readonly from: Record<S, number>
  target: S
  elapsedMs: number
  durationMs: number
  /** False once the weights have settled; the frame loop then skips all blend work. */
  active: boolean
}

export function createStateMix<S extends string>(
  states: readonly S[],
  target: S,
  durationMs: number = STATE_TRANSITION_MS
): StateMix<S> {
  const weights = {} as Record<S, number>
  const from = {} as Record<S, number>
  for (const s of states) {
    weights[s] = s === target ? 1 : 0
    from[s] = weights[s]
  }
  return { states, weights, from, target, elapsedMs: durationMs, durationMs, active: false }
}

/**
 * Aim the mix at a new state. `from` is snapshotted from the CURRENT weights,
 * which is the whole point: a transition interrupted halfway continues from
 * where it visibly is instead of restarting from the state it was heading to.
 *
 * Retargeting to the state already being headed for is a no-op — the in-flight
 * transition keeps running rather than restarting from its own midpoint.
 */
export function retargetStateMix<S extends string>(mix: StateMix<S>, target: S, reduced = false): void {
  if (mix.target === target) return
  for (const s of mix.states) mix.from[s] = mix.weights[s]
  mix.target = target
  mix.elapsedMs = 0
  mix.active = true
  if (reduced || mix.durationMs <= 0) {
    // Snap, but stay `active` for one frame so the renderer still writes the
    // target's values out; a reduced-motion map must be correct, just instant.
    for (const s of mix.states) {
      mix.from[s] = s === target ? 1 : 0
      mix.weights[s] = mix.from[s]
    }
    mix.elapsedMs = mix.durationMs
  }
}

/**
 * Advance by a frame delta (seconds). Returns true while the weights still
 * need to be applied — including the final frame that lands on the target, so
 * the caller writes the settled values once before going idle.
 */
export function advanceStateMix<S extends string>(mix: StateMix<S>, deltaSec: number): boolean {
  if (!mix.active) return false
  mix.elapsedMs += deltaSec * 1000
  const raw = mix.durationMs <= 0 ? 1 : Math.min(1, mix.elapsedMs / mix.durationMs)
  const t = easeMotion(raw)
  for (const s of mix.states) {
    const to = s === mix.target ? 1 : 0
    mix.weights[s] = mix.from[s] + (to - mix.from[s]) * t
  }
  if (raw >= 1) mix.active = false
  return true
}

// --- scalar tween ---------------------------------------------------------

export interface Tween {
  from: number
  to: number
  value: number
  elapsedMs: number
  durationMs: number
  active: boolean
}

export function createTween(value: number, durationMs: number): Tween {
  return { from: value, to: value, value, elapsedMs: durationMs, durationMs, active: false }
}

/**
 * How long an `ended` planet takes to leave (and return to) the map when the
 * ENDED readout is toggled. Canvas 2a:
 * `transition:opacity .5s ease, transform .5s ease`.
 */
export const ENDED_HIDE_MS = 500
/** Scale a suppressed ended planet settles at — canvas 2a's `scale(.82)`. */
export const ENDED_HIDDEN_SCALE = 0.82

/**
 * The whole-planet opacity and scale multipliers for the ENDED suppression,
 * given a fade value where 1 is fully shown and 0 fully hidden.
 *
 * Multipliers, not absolutes: an ended planet is already dimmed at rest
 * (`DIMMED_OPACITY`, the artboard's `opacity:.6`), and this must not dim it
 * a second time — at `fade === 1` it has to be an exact no-op.
 */
export function endedHideTransform(fade: number): { opacity: number; scale: number } {
  return {
    opacity: fade,
    scale: ENDED_HIDDEN_SCALE + (1 - ENDED_HIDDEN_SCALE) * fade,
  }
}

export function retargetTween(tw: Tween, to: number, durationMs = tw.durationMs, reduced = false): void {
  if (tw.to === to) return
  tw.from = tw.value
  tw.to = to
  tw.durationMs = durationMs
  tw.elapsedMs = reduced ? durationMs : 0
  tw.active = true
}

export function advanceTween(tw: Tween, deltaSec: number): boolean {
  if (!tw.active) return false
  tw.elapsedMs += deltaSec * 1000
  const raw = tw.durationMs <= 0 ? 1 : Math.min(1, tw.elapsedMs / tw.durationMs)
  tw.value = tw.from + (tw.to - tw.from) * easeMotion(raw)
  if (raw >= 1) {
    tw.value = tw.to
    tw.active = false
  }
  return true
}

// --- point tween ----------------------------------------------------------

/**
 * How long a body takes to walk to a new place on the map.
 *
 * Deliberately slower than `STATE_TRANSITION_MS`: a state change is a body
 * changing appearance in place, whereas retagging is a MIGRATION — the layout
 * moves the session into another cluster and renumbers both spirals, so the
 * planet crosses a large part of the map. At 420ms that trip still reads as a
 * teleport with motion blur; at 700ms the eye can follow which planet went
 * where, which is the whole point of animating it.
 */
export const BODY_MOVE_MS = 700

/**
 * Two tweens driven as one, for a body's `x`/`y`. Same duration and curve on
 * both axes, so the path is a straight line eased along its length rather
 * than a curve that arrives on one axis before the other.
 */
export interface PointTween {
  x: Tween
  y: Tween
}

export function createPointTween(x: number, y: number, durationMs: number): PointTween {
  return { x: createTween(x, durationMs), y: createTween(y, durationMs) }
}

export function retargetPointTween(pt: PointTween, x: number, y: number, reduced = false): void {
  retargetTween(pt.x, x, pt.x.durationMs, reduced)
  retargetTween(pt.y, y, pt.y.durationMs, reduced)
}

/** Advances both axes. Returns true if either moved this frame. */
export function advancePointTween(pt: PointTween, deltaSec: number): boolean {
  // Both sides always evaluated — `||` would skip advancing y on any frame
  // where x was still moving.
  const movedX = advanceTween(pt.x, deltaSec)
  const movedY = advanceTween(pt.y, deltaSec)
  return movedX || movedY
}

/**
 * Signed angular distance from `from` to `to` on the hue circle, in
 * (-180, 180]. Retagging 350° → 10° must cross 0°, not run 340° the long way
 * round through every other tag colour.
 */
export function shortestHueDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180
}

/**
 * Aim a hue tween at `hue`. The tween carries an UNWRAPPED angle (it may run
 * past 360 or below 0) so the interpolation itself never has to think about
 * the wrap; callers hand `value` straight to the OKLCH conversion, whose
 * `cos`/`sin` are periodic anyway.
 */
export function retargetHueTween(tw: Tween, hue: number, reduced = false): void {
  const to = tw.value + shortestHueDelta(tw.value, hue)
  if (Math.abs(to - tw.value) < 1e-9) return
  tw.from = tw.value
  tw.to = to
  tw.elapsedMs = reduced ? tw.durationMs : 0
  tw.active = true
}

// --- layer compositing ----------------------------------------------------

/**
 * Per-layer alphas for drawing N fully-overlapping layers so the composite
 * equals `Σ weightᵢ · layerᵢ`.
 *
 * Painting layer i over what is already there contributes
 * `aᵢ · Π_{j>i}(1 - aⱼ)`, so the alphas are solved from the top down against
 * the coverage still unspent. `weights` and `out` are indexed BOTTOM to TOP
 * (`out[0]` is the layer drawn first / furthest back).
 *
 * This is the crossfade primitive for the planet body, where the three fills
 * are different materials that cannot be averaged into one. Writes into `out`
 * so the frame loop allocates nothing.
 */
export function stackAlphas(weights: readonly number[], out: number[]): number[] {
  let remaining = 1
  for (let i = weights.length - 1; i >= 0; i--) {
    const a = remaining > 1e-6 ? Math.min(1, Math.max(0, weights[i] / remaining)) : 0
    out[i] = a
    remaining *= 1 - a
  }
  return out
}

// --- planet ---------------------------------------------------------------

export const PLANET_STATES: readonly SessionStatus[] = ['working', 'idle', 'needs_input', 'ended']

/** The pure table's literal value set per state, resolved once (never per frame). */
const PLANET_TABLE = {
  working: planetVisuals('working', false),
  idle: planetVisuals('idle', false),
  needs_input: planetVisuals('needs_input', false),
  ended: planetVisuals('ended', false),
} satisfies Record<SessionStatus, PlanetVisuals>

/** One crossfadeable tick-ring form: the fields that have no midpoint, plus which states wear it. */
export interface TickLayer {
  /** States drawn by this ring; its live alpha is the sum of their weights. */
  readonly states: readonly SessionStatus[]
  readonly count: number
  readonly widthDeg: number
  readonly radius: number
  readonly length: number
  readonly opacity: number
  /** True where the export draws the ring grey instead of in the tag hue (ended). */
  readonly grey: boolean
}

/**
 * The DISTINCT tick rings across the four states, deduplicated.
 *
 * The export gives working 60 ticks, idle and needs-input 45, ended 30 — and
 * idle/needs-input are byte-identical, so they share one layer and an
 * idle ⇄ needs-input change costs no crossfade at all. Three layers are
 * mounted per planet; at rest exactly one is visible.
 */
export const PLANET_TICK_LAYERS: readonly TickLayer[] = (() => {
  const layers: TickLayer[] = []
  for (const state of PLANET_STATES) {
    const v = PLANET_TABLE[state]
    const match = layers.find(
      (l) =>
        l.count === v.tickCount &&
        l.widthDeg === v.tickWidthDeg &&
        l.radius === v.tickRadius &&
        l.length === v.tickLength &&
        l.opacity === v.tickOpacity
    )
    if (match) {
      ;(match.states as SessionStatus[]).push(state)
      continue
    }
    layers.push({
      states: [state],
      count: v.tickCount,
      widthDeg: v.tickWidthDeg,
      radius: v.tickRadius,
      length: v.tickLength,
      opacity: v.tickOpacity,
      grey: v.dimmed,
    })
  }
  return layers
})()

/** Summed weight of the states a tick layer covers — that layer's crossfade alpha. */
export function tickLayerWeight(layer: TickLayer, weights: Record<SessionStatus, number>): number {
  let sum = 0
  for (const s of layer.states) sum += weights[s]
  return sum
}

/** Continuous planet fields, blended. Discrete ring/body forms are NOT here — they crossfade. */
export interface PlanetBlend {
  tickSpin: number
  arcOpacity: number
  arcSpin: number
  corePulse: number
  corePulseSec: number
  coreOpacity: number
  coreRadius: number
  haloOpacity: number
  /** How much of the working halo's `orb-ring` breathing to apply (0…1). */
  haloBreath: number
  /** The export's `opacity:.6` ended wrapper, eased: 1 → DIMMED_OPACITY. */
  dim: number
  /** How much the white needs-input ripple is showing (0…1). */
  ripple: number
}

export function createPlanetBlend(): PlanetBlend {
  return {
    tickSpin: 0,
    arcOpacity: 0,
    arcSpin: 0,
    corePulse: 0,
    corePulseSec: 0,
    coreOpacity: 0,
    coreRadius: 0,
    haloOpacity: 0,
    haloBreath: 0,
    dim: 1,
    ripple: 0,
  }
}

export function blendPlanet(weights: Record<SessionStatus, number>, out: PlanetBlend): PlanetBlend {
  let tickSpin = 0
  let arcOpacity = 0
  let arcSpin = 0
  let corePulse = 0
  let pulseSecWeighted = 0
  let coreOpacity = 0
  let coreRadius = 0
  let haloOpacity = 0
  let haloBreath = 0
  let dimmed = 0
  let ripple = 0

  for (const state of PLANET_STATES) {
    const w = weights[state]
    if (w === 0) continue
    const v = PLANET_TABLE[state]
    tickSpin += w * v.tickSpin
    arcOpacity += w * v.arcOpacity
    arcSpin += w * v.arcSpin
    corePulse += w * v.corePulse
    pulseSecWeighted += w * v.corePulse * v.corePulseSec
    coreOpacity += w * v.coreOpacity
    coreRadius += w * v.coreRadius
    haloOpacity += w * v.haloOpacity
    if (v.haloBreathes) haloBreath += w
    if (v.dimmed) dimmed += w
    if (v.rippleActive) ripple += w
  }

  out.tickSpin = tickSpin
  out.arcOpacity = arcOpacity
  out.arcSpin = arcSpin
  out.corePulse = corePulse
  // Weighted by pulse depth, so a still state drags the period toward 0 only
  // by ceasing to blink — never by strobing.
  out.corePulseSec = corePulse > 1e-6 ? pulseSecWeighted / corePulse : 0
  out.coreOpacity = coreOpacity
  out.coreRadius = coreRadius
  out.haloOpacity = haloOpacity
  out.haloBreath = haloBreath
  out.dim = 1 - dimmed * (1 - DIMMED_OPACITY)
  out.ripple = ripple
  return out
}

// --- moon -----------------------------------------------------------------

export const MOON_STATES: readonly Subagent['state'][] = [
  'materializing',
  'working',
  'idle',
  'needs_input',
  'ended',
]

const MOON_TABLE = {
  materializing: moonVisuals('materializing'),
  working: moonVisuals('working'),
  idle: moonVisuals('idle'),
  needs_input: moonVisuals('needs_input'),
  ended: moonVisuals('ended'),
} satisfies Record<Subagent['state'], MoonVisuals>

/** Continuous moon fields. `materializing` is the one crossfade weight. */
export interface MoonBlend {
  tickSpin: number
  discRadius: number
  rimOpacity: number
  coreRadius: number
  coreOpacity: number
  corePulse: number
  corePulseSec: number
  glowSize: number
  glowOpacity: number
  trailOpacity: number
  dim: number
  ripple: number
  /**
   * Crossfade weight between the solid disc + rim and the materializing
   * dashed shell + expanding ring. They are different objects, so this fades
   * one set out as it fades the other in rather than blending any value.
   */
  materializing: number
}

export function createMoonBlend(): MoonBlend {
  return {
    tickSpin: 0,
    discRadius: 0,
    rimOpacity: 0,
    coreRadius: 0,
    coreOpacity: 0,
    corePulse: 0,
    corePulseSec: 0,
    glowSize: 0,
    glowOpacity: 0,
    trailOpacity: 0,
    dim: 1,
    ripple: 0,
    materializing: 0,
  }
}

export function blendMoon(weights: Record<Subagent['state'], number>, out: MoonBlend): MoonBlend {
  let tickSpin = 0
  let discRadius = 0
  let rimOpacity = 0
  let coreRadius = 0
  let coreOpacity = 0
  let corePulse = 0
  let pulseSecWeighted = 0
  let glowSize = 0
  let glowOpacity = 0
  let trailOpacity = 0
  let dimmed = 0
  let ripple = 0
  let materializing = 0

  for (const state of MOON_STATES) {
    const w = weights[state]
    if (w === 0) continue
    const v = MOON_TABLE[state]
    tickSpin += w * v.tickSpin
    discRadius += w * v.discRadius
    rimOpacity += w * v.rimOpacity
    coreRadius += w * v.coreRadius
    coreOpacity += w * v.coreOpacity
    corePulse += w * v.corePulse
    pulseSecWeighted += w * v.corePulse * v.corePulseSec
    glowSize += w * v.glowSize
    glowOpacity += w * v.glowOpacity
    trailOpacity += w * v.trailOpacity
    if (v.dimmed) dimmed += w
    if (v.rippleActive) ripple += w
    if (v.matRing || v.dashedShell) materializing += w
  }

  out.tickSpin = tickSpin
  out.discRadius = discRadius
  out.rimOpacity = rimOpacity
  out.coreRadius = coreRadius
  out.coreOpacity = coreOpacity
  out.corePulse = corePulse
  out.corePulseSec = corePulse > 1e-6 ? pulseSecWeighted / corePulse : 0
  out.glowSize = glowSize
  out.glowOpacity = glowOpacity
  out.trailOpacity = trailOpacity
  out.dim = 1 - dimmed * (1 - DIMMED_OPACITY)
  out.ripple = ripple
  out.materializing = materializing
  return out
}

// --- hooks ----------------------------------------------------------------

/**
 * A `StateMix` that follows `target`, living in a ref so a state change never
 * costs a React render per frame — the frame loop mutates it in place and the
 * components write the result straight onto three.js materials.
 */
export function useStateMix<S extends string>(
  states: readonly S[],
  target: S,
  durationMs: number = STATE_TRANSITION_MS
): StateMix<S> {
  const ref = useRef<StateMix<S> | null>(null)
  if (ref.current === null) ref.current = createStateMix(states, target, durationMs)
  const mix = ref.current
  // Layout effect, not render: mutating the ref during render would fire twice
  // under StrictMode and start the transition from a half-applied state.
  useLayoutEffect(() => {
    retargetStateMix(mix, target, prefersReducedMotion())
  }, [mix, target])
  return mix
}

/** Hue angle tween — retagging a session eases its colour across rather than cutting. */
export function useHueTween(hue: number, durationMs: number = STATE_TRANSITION_MS): Tween {
  const ref = useRef<Tween | null>(null)
  if (ref.current === null) ref.current = createTween(hue, durationMs)
  const tw = ref.current
  useLayoutEffect(() => {
    retargetHueTween(tw, hue, prefersReducedMotion())
  }, [tw, hue])
  return tw
}

/**
 * Position tween for a body the layout has moved — retagging a session walks
 * it over to its new cluster instead of cutting it there.
 *
 * The caller renders the tween's CURRENT value as the JSX `position` (not the
 * incoming `x`/`y`): R3F re-applies that prop on every re-render, and the
 * re-render that delivers a new target happens one frame BEFORE the tween
 * starts — so rendering the target would plant the body at the destination
 * for a frame and then yank it back to the start.
 */
export function usePointTween(x: number, y: number, durationMs: number = BODY_MOVE_MS): PointTween {
  const ref = useRef<PointTween | null>(null)
  if (ref.current === null) ref.current = createPointTween(x, y, durationMs)
  const pt = ref.current
  useLayoutEffect(() => {
    retargetPointTween(pt, x, y, prefersReducedMotion())
  }, [pt, x, y])
  return pt
}

/** 0 ⇄ 1 fade with a shorter exit than entrance, per `ui/motion.ts`'s rule. */
export function useFadeTween(open: boolean, enterMs: number, exitMs: number): Tween {
  const ref = useRef<Tween | null>(null)
  if (ref.current === null) ref.current = createTween(open ? 1 : 0, enterMs)
  const tw = ref.current
  useLayoutEffect(() => {
    retargetTween(tw, open ? 1 : 0, open ? enterMs : exitMs, prefersReducedMotion())
  }, [tw, open, enterMs, exitMs])
  return tw
}

/**
 * Keeps a node mounted for `holdMs` after `open` goes false, so something that
 * React would otherwise yank out of the tree has frames left to fade in which
 * to fade. One state update per change — never per frame.
 */
export function useLingering(open: boolean, holdMs: number): boolean {
  const [visible, setVisible] = useState(open)
  useEffect(() => {
    if (open) {
      setVisible(true)
      return
    }
    if (prefersReducedMotion() || holdMs <= 0) {
      setVisible(false)
      return
    }
    const timer = setTimeout(() => setVisible(false), holdMs)
    return () => clearTimeout(timer)
  }, [open, holdMs])
  return visible || open
}
