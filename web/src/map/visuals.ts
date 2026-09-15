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
  /** Number of radial ticks — dense for working, sparser as activity fades (canvas 1a: 60/38/26). */
  tickCount: number
  /** Tick opacity (canvas: working .9, idle .45, ended .4 grey). */
  tickOpacity: number
  /** Core pulse amplitude (0 = steady, no pulse; 1 = full breathing pulse). */
  corePulse: number
  /** Core disc opacity (canvas: working 1, idle .8, ended none). */
  coreOpacity: number
  /** Opacity of the breathing halo ring hugging the body (canvas peak .18, working only). */
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

/**
 * Values below are transcribed from the design export's inline CSS
 * (artboard 1a planets + 1f state sheet in `Orbital.dc.html`):
 * working = dense bright spinning ticks (repeating-conic 1.2deg/6deg → 60),
 * pulsing full core, breathing halo ring at .18 peak; idle = sparser static
 * ticks (1.5deg/9.5deg → 38) at .45, steady .8 core, no halo; ended = grey
 * sparse ticks (2deg/14deg → 26) at .4, no core, no halo, dimmed.
 */
const PLANET_VISUALS: Record<SessionStatus, Omit<PlanetVisuals, 'reticle'>> = {
  working: {
    tickSpin: 0.4,
    tickCount: 60,
    tickOpacity: 0.9,
    corePulse: 1,
    coreOpacity: 1,
    haloOpacity: 0.18,
    haloBreathes: true,
    rippleActive: false,
    dimmed: false,
  },
  idle: {
    tickSpin: 0,
    tickCount: 38,
    tickOpacity: 0.45,
    corePulse: 0,
    coreOpacity: 0.8,
    haloOpacity: 0,
    haloBreathes: false,
    rippleActive: false,
    dimmed: false,
  },
  needs_input: {
    tickSpin: 0,
    tickCount: 60,
    tickOpacity: 0.9,
    corePulse: 1,
    coreOpacity: 1,
    haloOpacity: 0,
    haloBreathes: false,
    rippleActive: true,
    dimmed: false,
  },
  ended: {
    tickSpin: 0,
    tickCount: 26,
    tickOpacity: 0.4,
    corePulse: 0,
    coreOpacity: 0,
    haloOpacity: 0,
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
