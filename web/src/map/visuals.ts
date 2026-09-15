import type { SessionStatus, Subagent } from '../lib/types'

/**
 * Parametric visual state for planets/moons. Pure and deterministic: the
 * same (state, selected) always produces the exact same output.
 *
 * BINDING rule (design spec "State system rule" + task-8 brief): hue always
 * comes from the session/subagent's tag; these tables carry state ONLY
 * through motion + core (rotation speed, pulse, ripple, dim/opacity). There
 * is intentionally no hue/color field anywhere in these outputs — the
 * `Planet`/`Moon` components apply `tagColor(hue)` themselves, and switch to
 * white only for the needs-input ripple/core, never re-deriving a hue.
 */

// --- Planet ------------------------------------------------------------

export interface PlanetVisuals {
  /** Tick-ring rotation speed (radians/sec applied in useFrame). 0 = static. */
  tickSpin: number
  /** Core pulse amplitude (0 = steady, no pulse; 1 = full breathing pulse). */
  corePulse: number
  /** Opacity of the soft halo circle behind the planet. */
  haloOpacity: number
  /** Whether the halo breathes (soft opacity oscillation) — true only for `working`; steady otherwise. */
  haloBreathes: boolean
  /** Whether the needs-input expanding white ripple ring is active. */
  rippleActive: boolean
  /**
   * Ended: session rendered dimmed (lower opacity). Reduced scale is NOT
   * carried by this flag — it comes from the layout's `scale` prop
   * (`ENDED_SCALE` in `map/layout.ts`, Task 7), which the component applies
   * directly to its root group regardless of this table.
   */
  dimmed: boolean
  /** Selection reticle (slow dashed ring + corner brackets) shown. */
  reticle: boolean
}

/** Working: ticks rotate, core pulses, halo breathes (state sheet 2d). */
const WORKING_TICK_SPIN = 0.4
const WORKING_CORE_PULSE = 1
const WORKING_HALO_OPACITY = 0.5

/** Idle: ticks static, steady (non-pulsing) core, dimmer halo. */
const IDLE_TICK_SPIN = 0
const IDLE_CORE_PULSE = 0
const IDLE_HALO_OPACITY = 0.25

/**
 * Needs input: white expanding ripple + white core (component swaps the
 * core material to white; this table only says the core pulses and the
 * ripple runs). Ticks stay static like idle — the ripple carries the
 * attention cue, not tick motion.
 */
const NEEDS_INPUT_TICK_SPIN = 0
const NEEDS_INPUT_CORE_PULSE = 1
const NEEDS_INPUT_HALO_OPACITY = 0.5

/** Ended: grey ticks (static), no core, no halo, dimmed + small (state sheet). */
const ENDED_TICK_SPIN = 0
const ENDED_CORE_PULSE = 0
const ENDED_HALO_OPACITY = 0

const PLANET_VISUALS: Record<SessionStatus, Omit<PlanetVisuals, 'reticle'>> = {
  working: {
    tickSpin: WORKING_TICK_SPIN,
    corePulse: WORKING_CORE_PULSE,
    haloOpacity: WORKING_HALO_OPACITY,
    haloBreathes: true,
    rippleActive: false,
    dimmed: false,
  },
  idle: {
    tickSpin: IDLE_TICK_SPIN,
    corePulse: IDLE_CORE_PULSE,
    haloOpacity: IDLE_HALO_OPACITY,
    haloBreathes: false,
    rippleActive: false,
    dimmed: false,
  },
  needs_input: {
    tickSpin: NEEDS_INPUT_TICK_SPIN,
    corePulse: NEEDS_INPUT_CORE_PULSE,
    haloOpacity: NEEDS_INPUT_HALO_OPACITY,
    haloBreathes: false,
    rippleActive: true,
    dimmed: false,
  },
  ended: {
    tickSpin: ENDED_TICK_SPIN,
    corePulse: ENDED_CORE_PULSE,
    haloOpacity: ENDED_HALO_OPACITY,
    haloBreathes: false,
    rippleActive: false,
    dimmed: true,
  },
}

/**
 * Visual params for a planet given its session status and whether it is
 * currently selected. `selected` is orthogonal to `state`: it only ever
 * toggles `reticle`, never any of the other fields.
 */
export function planetVisuals(state: SessionStatus, selected: boolean): PlanetVisuals {
  return { ...PLANET_VISUALS[state], reticle: selected }
}

// --- Moon ----------------------------------------------------------------

export interface MoonVisuals {
  /** Micro tick-ring rotation speed (radians/sec). 0 = static. */
  tickSpin: number
  /** Core disc opacity (dim for idle/ended/forming, full for working/needs_input). */
  coreOpacity: number
  /** Whether the needs-input/materializing expanding white ripple is active. */
  rippleActive: boolean
  /** Materializing: dashed shell (fading in) instead of a solid outline. */
  dashedShell: boolean
  /** Ended: grey disc, dimmed. */
  dimmed: boolean
  /** Opacity of the dashed orbit trail ring. */
  trailOpacity: number
}

/** Working: micro tick ring spins, full core, orbit trail visible. */
const MOON_WORKING_TICK_SPIN = 0.6
const MOON_WORKING_CORE_OPACITY = 1
const MOON_WORKING_TRAIL_OPACITY = 0.4

/** Idle: static disc, dim core. */
const MOON_IDLE_CORE_OPACITY = 0.5
const MOON_IDLE_TRAIL_OPACITY = 0.25

/** Needs input: white ripple, full core. */
const MOON_NEEDS_INPUT_CORE_OPACITY = 1
const MOON_NEEDS_INPUT_TRAIL_OPACITY = 0.4

/** Materializing: dashed shell fades in, ripple expands, core still forming. */
const MOON_MATERIALIZING_CORE_OPACITY = 0.3
const MOON_MATERIALIZING_TRAIL_OPACITY = 0.15

/** Ended: grey disc (dimmed), orbit trail fades. */
const MOON_ENDED_CORE_OPACITY = 0.3
const MOON_ENDED_TRAIL_OPACITY = 0.08

const MOON_VISUALS: Record<Subagent['state'], MoonVisuals> = {
  working: {
    tickSpin: MOON_WORKING_TICK_SPIN,
    coreOpacity: MOON_WORKING_CORE_OPACITY,
    rippleActive: false,
    dashedShell: false,
    dimmed: false,
    trailOpacity: MOON_WORKING_TRAIL_OPACITY,
  },
  idle: {
    tickSpin: 0,
    coreOpacity: MOON_IDLE_CORE_OPACITY,
    rippleActive: false,
    dashedShell: false,
    dimmed: false,
    trailOpacity: MOON_IDLE_TRAIL_OPACITY,
  },
  needs_input: {
    tickSpin: 0,
    coreOpacity: MOON_NEEDS_INPUT_CORE_OPACITY,
    rippleActive: true,
    dashedShell: false,
    dimmed: false,
    trailOpacity: MOON_NEEDS_INPUT_TRAIL_OPACITY,
  },
  materializing: {
    tickSpin: 0,
    coreOpacity: MOON_MATERIALIZING_CORE_OPACITY,
    rippleActive: true,
    dashedShell: true,
    dimmed: false,
    trailOpacity: MOON_MATERIALIZING_TRAIL_OPACITY,
  },
  ended: {
    tickSpin: 0,
    coreOpacity: MOON_ENDED_CORE_OPACITY,
    rippleActive: false,
    dashedShell: false,
    dimmed: true,
    trailOpacity: MOON_ENDED_TRAIL_OPACITY,
  },
}

/**
 * Visual params for a moon given its subagent state. Returns a fresh copy
 * each call (not the shared table entry) so a caller mutating the result
 * can never corrupt the shared state table for every other moon in that
 * state.
 */
export function moonVisuals(state: Subagent['state']): MoonVisuals {
  return { ...MOON_VISUALS[state] }
}

/** Max characters shown in a planet's map label (design shows short names). */
export const LABEL_MAX_CHARS = 26

/** Shorten a session title for the map label, appending an ellipsis. */
export function truncateLabel(title: string, max: number = LABEL_MAX_CHARS): string {
  if (title.length <= max) return title
  return `${title.slice(0, max - 1).trimEnd()}…`
}
