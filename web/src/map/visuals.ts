import type { SessionStatus, Subagent } from '../lib/types'
import type { DotShape, MapStatePills } from '../lib/stateStyle'

/**
 * Parametric visual state for planets/moons. Pure and deterministic: the
 * same (state, selected) always produces the exact same output.
 *
 * BINDING rule (design spec "State system rule" + task-8 brief): hue always
 * comes from the session/subagent's tag; these tables carry state ONLY
 * through geometry + motion + core (ring radii, rotation speed, pulse,
 * ripple, dim/opacity). There is intentionally no hue/color field anywhere
 * in these outputs — the `Planet`/`Moon` components apply `tagColor(hue)`
 * themselves, and switch to white only for the needs-input ripple/core,
 * never re-deriving a hue.
 *
 * UNIT CONVENTION: the design export draws the state sheet (artboard 1f)
 * with a 100px planet body, i.e. a 50px body radius; the scene draws it at
 * `BODY_RADIUS = 0.48`. Every length below is therefore
 * `designPx / 50 * 0.48` (= designPx * 0.0096) and is quoted with the
 * export's own `inset:` value so the transcription stays checkable.
 */

/** Planet body radius in scene units (96px body in artboard 1a at 0.01 units/px). */
export const BODY_RADIUS = 0.48

/** designPx → scene units, relative to artboard 1f's 50px body radius. */
const px = (designPx: number) => (designPx / 50) * BODY_RADIUS

/** CSS `animation: orb-spin <sec>` → radians/sec. Negative = `reverse`. */
const spin = (seconds: number) => (Math.PI * 2) / seconds

/**
 * The context gauge's outermost edge — its threshold-tick ring, artboard 1i
 * (the full transcription note lives with the gauge constants in
 * `Planet.tsx`). Exported from here rather than from `Planet.tsx` because
 * `sceneModel.ts` keeps moon orbits clear of the gauge and must stay free
 * of three.js imports.
 */
export const CONTEXT_GAUGE_OUTER = px(92)

// --- What hangs off a planet ------------------------------------------------
// Offsets `Planet` draws its label, pill and reticle brackets at, in local
// units before the planet's scale. They live here, not in `Planet.tsx`, for
// the same reason as CONTEXT_GAUGE_OUTER: the simulation keeps neighbours
// clear of them and must stay free of three.js. The transcription notes
// stay with the drawing code in `Planet.tsx`.

/** Selection reticle's corner brackets (1f: `±50px` spans on a 100px body, i.e. `inset:-50px`). */
export const BRACKET_INSET = px(100)
/** The label's gap under whatever it hangs below: the `34px` of `top: calc(100% + 34px)`. */
const LABEL_GAP = px(34)
/** Top edge of the resting label: `top: calc(100% + 34px)` under the body box. */
export const LABEL_TOP_REST_Y = -(BODY_RADIUS + LABEL_GAP)
/** …and under a context gauge's tick ring instead, with the same gap. */
export const LABEL_GAUGED_REST_Y = -(CONTEXT_GAUGE_OUTER + LABEL_GAP)
/** …and under the selection reticle's bracket square, with the same gap. */
export const LABEL_SELECTED_REST_Y = -(BRACKET_INSET + LABEL_GAP)

/**
 * Where the label's top edge rests: under the lowest thing the planet draws
 * below its body — the reticle's brackets while selected, the gauge's tick
 * ring while gauged, the body otherwise. `Planet` places the label with it
 * and `planetOutline` measures it, so the two cannot disagree.
 */
export function labelRestY(gauged: boolean, selected: boolean): number {
  return Math.min(
    LABEL_TOP_REST_Y,
    gauged ? LABEL_GAUGED_REST_Y : 0,
    selected ? LABEL_SELECTED_REST_Y : 0
  )
}
/** State pill's top-left corner (1f: `left: calc(100% + 10px); top: -12px` off the body box). */
export const BADGE_OFFSET_X = px(60)
export const BADGE_OFFSET_Y = px(62)
/** …and on a gauged planet, 1i's `/compact` position (`left: calc(100% + 36px); top: -21px`). */
export const COMPACT_BADGE_OFFSET_X = px(84)
export const COMPACT_BADGE_OFFSET_Y = px(70)

// --- Planet ------------------------------------------------------------

export interface PlanetVisuals {
  /** Tick-ring rotation speed (radians/sec applied in useFrame). 0 = static. */
  tickSpin: number
  /** Number of radial ticks = 360 / the export's repeating-conic period. */
  tickCount: number
  /** Each tick's angular width in degrees (the "on" slice of the conic gradient). */
  tickWidthDeg: number
  /** Mid-radius of the tick band, scene units. */
  tickRadius: number
  /** Radial length of each tick (the mask band's width), scene units. */
  tickLength: number
  /** Tick opacity (canvas: working .9, idle/needs-input .45, ended .4 grey). */
  tickOpacity: number
  /**
   * Thin inner arc ring: `repeating-conic-gradient(hue/.5 0 60deg, transparent
   * 60deg 90deg)` → four 60° arcs on a 90° pitch. 0 = ring absent.
   */
  arcOpacity: number
  /** Arc-ring rotation speed (radians/sec); negative because the export spins it `reverse`. */
  arcSpin: number
  /** Core blink depth (0 = steady; 1 = full `orb-blink`, opacity 1 → .3 → 1). */
  corePulse: number
  /** Core blink period in seconds (`orb-blink 2.4s` working, `1.2s` needs-input). */
  corePulseSec: number
  /** Core disc opacity (canvas: working 1, idle .8, ended none). */
  coreOpacity: number
  /** Core disc radius, scene units (canvas: 16px working/needs-input, 14px idle). */
  coreRadius: number
  /** Opacity of the breathing halo ring hugging the body (canvas peak .18, working only). */
  haloOpacity: number
  /** Whether the halo breathes (`orb-ring`, opacity ×.55 → ×1) — true only for `working`. */
  haloBreathes: boolean
  /** Whether the needs-input expanding white ripple ring is active. */
  rippleActive: boolean
  /**
   * Ended: session rendered dimmed (the export wraps it in `opacity:.6`).
   * Reduced scale is NOT carried by this flag — it comes from the layout's
   * `scale` prop (`ENDED_SCALE` in `map/layout.ts`, Task 7), which the
   * component applies directly to its root group regardless of this table.
   */
  dimmed: boolean
  /** Selection reticle (slow dashed ring + corner brackets) shown. */
  reticle: boolean
}

/** `opacity:.6` wrapper the export puts around every ended body (1a/1f/2d). */
export const DIMMED_OPACITY = 0.6

/**
 * Whole-body opacity of a planet (and its moons) that does not match the
 * sidebar search (ADR `search-mutes-planets-instead-of-hiding-them`). The
 * canvas draws no search state, so this is a judgement call: clearly below
 * `DIMMED_OPACITY`, so a muted WORKING planet reads as "not this one" next to
 * an ended planet that matches. It multiplies onto the ended dim rather than
 * replacing it, so a muted ended planet sits lower still.
 */
export const MUTED_OPACITY = 0.28

/** `orb-ring 2.4s` — the working halo's breathing period. */
export const HALO_BREATH_SEC = 2.4
/** `orb-ring` keyframes: opacity .55 at 0/100%, 1 at 50% — a multiplier on `haloOpacity`. */
export const HALO_BREATH_MIN = 0.55

/**
 * Values below are transcribed from the design export's inline CSS — the
 * state sheet `1f` in `Orbital.dc.html` is the reference (its five planets
 * are all drawn at the same 100px body), cross-checked against 1a, 1c and
 * the chosen `2d Instrument` variant, which agree on every tick gradient:
 *   working      hue/.9  0 1.2deg, transparent 1.2deg 6deg   → 60 ticks
 *   idle + needs hue/.45 0 1.5deg, transparent 1.5deg 8deg   → 45 ticks
 *   ended        grey/.4 0 2deg,   transparent 2deg 12deg    → 30 ticks
 */
const PLANET_VISUALS: Record<SessionStatus, Omit<PlanetVisuals, 'reticle'>> = {
  // 1f: halo inset -28, ticks inset -26 (8px band) spinning 24s, arc ring
  // inset -14 (2px band) spinning 60s reverse, 16px core blinking 2.4s.
  working: {
    tickSpin: spin(24),
    tickCount: 60,
    tickWidthDeg: 1.2,
    tickRadius: px(76 - 8 / 2),
    tickLength: px(8),
    tickOpacity: 0.9,
    arcOpacity: 0.5,
    arcSpin: -spin(60),
    corePulse: 1,
    corePulseSec: 2.4,
    coreOpacity: 1,
    coreRadius: px(16 / 2),
    haloOpacity: 0.18,
    haloBreathes: true,
    rippleActive: false,
    dimmed: false,
  },
  // 1f: ticks inset -21 (7px band), static; 14px core at .8, no blink, no
  // halo, no arc ring, body border drops to hue/.45.
  idle: {
    tickSpin: 0,
    tickCount: 45,
    tickWidthDeg: 1.5,
    tickRadius: px(71 - 7 / 2),
    tickLength: px(7),
    tickOpacity: 0.45,
    arcOpacity: 0,
    arcSpin: 0,
    corePulse: 0,
    corePulseSec: 0,
    coreOpacity: 0.8,
    coreRadius: px(14 / 2),
    haloOpacity: 0,
    haloBreathes: false,
    rippleActive: false,
    dimmed: false,
  },
  // 1f: the idle body + tick ring exactly, plus a white `orb-pulse-out`
  // ripple at inset -21 and a white 16px core blinking at 1.2s.
  needs_input: {
    tickSpin: 0,
    tickCount: 45,
    tickWidthDeg: 1.5,
    tickRadius: px(71 - 7 / 2),
    tickLength: px(7),
    tickOpacity: 0.45,
    arcOpacity: 0,
    arcSpin: 0,
    corePulse: 1,
    corePulseSec: 1.2,
    coreOpacity: 1,
    coreRadius: px(16 / 2),
    haloOpacity: 0,
    haloBreathes: false,
    rippleActive: true,
    dimmed: false,
  },
  // 1f: grey ticks inset -22 (3px band), flat oklch(16% .01 230) body, no
  // core, whole body wrapped in opacity:.6.
  ended: {
    tickSpin: 0,
    tickCount: 30,
    tickWidthDeg: 2,
    tickRadius: px(72 - 3 / 2),
    tickLength: px(3),
    tickOpacity: 0.4,
    arcOpacity: 0,
    arcSpin: 0,
    corePulse: 0,
    corePulseSec: 0,
    coreOpacity: 0,
    coreRadius: px(14 / 2),
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
  /** Micro tick-ring rotation speed (radians/sec). 0 = static (no ring). */
  tickSpin: number
  /** Dark body disc radius, scene units (1f: 26/22/22/24/16px across states). */
  discRadius: number
  /** Hue rim drawn on the disc edge (`border:1px solid hue/<x>`). 0 = no rim. */
  rimOpacity: number
  /** Bright core radius, scene units. 0 = no core (materializing / ended). */
  coreRadius: number
  /** Core disc opacity. */
  coreOpacity: number
  /** Core blink depth (0 = steady; 1 = full `orb-blink`). */
  corePulse: number
  /** Core blink period in seconds (working 1.4s, needs-input 1.2s). */
  corePulseSec: number
  /** Soft glow quad size, scene units — the export's `box-shadow: 0 0 <n>px`. */
  glowSize: number
  /** Glow alpha (the box-shadow's colour alpha). 0 = no glow. */
  glowOpacity: number
  /** Whether the needs-input expanding WHITE ripple is active. */
  rippleActive: boolean
  /** Materializing: expanding HUE `orb-matring` (scale .6 → 2, opacity .8 → 0). */
  matRing: boolean
  /** Materializing: dashed shell breathing with `orb-mat` instead of a solid rim. */
  dashedShell: boolean
  /** Ended: grey disc, dimmed. */
  dimmed: boolean
  /** Opacity of the dashed orbit trail ring. */
  trailOpacity: number
}

/** 1f draws every moon orbit trail at `1px dashed hue/0.22`. */
const MOON_TRAIL_OPACITY = 0.22
/** "orbit trail fades" for an ended subagent (1f caption). */
const MOON_ENDED_TRAIL_OPACITY = 0.08

/** `orb-matring 1.8s ease-out`: scale .6 → 2, opacity .8 → 0. */
export const MAT_RING_SEC = 1.8
export const MAT_RING_MIN_SCALE = 0.6
export const MAT_RING_MAX_SCALE = 2
export const MAT_RING_START_OPACITY = 0.8

/** `orb-mat 1.8s ease-in-out`: opacity .3 ↔ .95, scale .85 ↔ 1. */
export const MAT_SHELL_SEC = 1.8
export const MAT_SHELL_MIN_OPACITY = 0.3
export const MAT_SHELL_MAX_OPACITY = 0.95
export const MAT_SHELL_MIN_SCALE = 0.85
export const MAT_SHELL_MAX_SCALE = 1

/** Micro tick ring: `hue/.9 0 4deg, transparent 4deg 18deg` → 20 ticks, `orb-spin 8s`. */
export const MOON_TICK_COUNT = 20
export const MOON_TICK_WIDTH_DEG = 4
/** inset -9 on a 26px disc → band 18…22px, mid 20px, 4px long. */
export const MOON_TICK_RADIUS = 0.2
export const MOON_TICK_LENGTH = 0.04
export const MOON_TICK_OPACITY = 0.9

/** Moons are quoted in the export in absolute px next to a 100px body → 0.01 units/px. */
const moonPx = (designPx: number) => designPx * 0.01

const MOON_VISUALS: Record<Subagent['state'], MoonVisuals> = {
  // 1f: 26px disc, hue/.9 rim, 0 0 16px hue/.7, micro tick ring (inset -9,
  // 4px band) spinning 8s, 6px core blinking 1.4s.
  working: {
    tickSpin: spin(8),
    discRadius: moonPx(26 / 2),
    rimOpacity: 0.9,
    coreRadius: moonPx(6 / 2),
    coreOpacity: 1,
    corePulse: 1,
    corePulseSec: 1.4,
    glowSize: moonPx(26 + 2 * 16),
    glowOpacity: 0.7,
    rippleActive: false,
    matRing: false,
    dashedShell: false,
    dimmed: false,
    trailOpacity: MOON_TRAIL_OPACITY,
  },
  // 1f: 22px disc, hue/.7 rim, 0 0 10px hue/.4, static 4px core at hue/.8.
  idle: {
    tickSpin: 0,
    discRadius: moonPx(22 / 2),
    rimOpacity: 0.7,
    coreRadius: moonPx(4 / 2),
    coreOpacity: 0.8,
    corePulse: 0,
    corePulseSec: 0,
    glowSize: moonPx(22 + 2 * 10),
    glowOpacity: 0.4,
    rippleActive: false,
    matRing: false,
    dashedShell: false,
    dimmed: false,
    trailOpacity: MOON_TRAIL_OPACITY,
  },
  // 1f: the idle disc, plus a white `orb-pulse-out` ripple at inset -4 and a
  // white 6px core (0 0 10px #fff) blinking at 1.2s.
  needs_input: {
    tickSpin: 0,
    discRadius: moonPx(22 / 2),
    rimOpacity: 0.7,
    coreRadius: moonPx(6 / 2),
    coreOpacity: 1,
    corePulse: 1,
    corePulseSec: 1.2,
    glowSize: moonPx(22 + 2 * 10),
    glowOpacity: 0.9,
    rippleActive: true,
    matRing: false,
    dashedShell: false,
    dimmed: false,
    trailOpacity: MOON_TRAIL_OPACITY,
  },
  // 1f: 24px dashed shell (hue/.9) over a hue/.6-glowing 60%-alpha fill,
  // breathing with `orb-mat`, under an expanding hue `orb-matring`. No core.
  materializing: {
    tickSpin: 0,
    discRadius: moonPx(24 / 2),
    rimOpacity: 0,
    coreRadius: 0,
    coreOpacity: 0,
    corePulse: 0,
    corePulseSec: 0,
    glowSize: moonPx(24 + 2 * 14),
    glowOpacity: 0.6,
    rippleActive: false,
    matRing: true,
    dashedShell: true,
    dimmed: false,
    trailOpacity: MOON_TRAIL_OPACITY,
  },
  // 1f: 16px flat oklch(16% .01 230) disc, grey/.35 rim, opacity:.6, no core.
  ended: {
    tickSpin: 0,
    discRadius: moonPx(16 / 2),
    rimOpacity: 0.35,
    coreRadius: 0,
    coreOpacity: 0,
    corePulse: 0,
    corePulseSec: 0,
    glowSize: 0,
    glowOpacity: 0,
    rippleActive: false,
    matRing: false,
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

// --- shared animation helpers -------------------------------------------

/**
 * CSS `ease-in-out` keyframes that go A → B → A over one period (`orb-blink`,
 * `orb-ring`, `orb-mat`): returns 0 at the period's ends and 1 at its middle.
 */
export function oscillate(elapsedSec: number, periodSec: number): number {
  if (periodSec <= 0) return 0
  return (1 - Math.cos((elapsedSec / periodSec) * Math.PI * 2)) / 2
}

/** CSS `ease-out` (cubic-bezier(0,0,.58,1)) approximated for the one-shot ripples. */
export function easeOut(progress: number): number {
  return 1 - (1 - progress) ** 2
}

/** Max characters shown in a planet's map label (design shows short names). */
export const LABEL_MAX_CHARS = 26

/** Shorten a session title for the map label, appending an ellipsis. */
export function truncateLabel(title: string, max: number = LABEL_MAX_CHARS): string {
  if (title.length <= max) return title
  return `${title.slice(0, max - 1).trimEnd()}…`
}

/**
 * Typing pace of the hover-expanded label. Judgement calls, not canvas
 * values — the canvas draws no hover states anywhere. The cap keeps a very
 * long title from typing forever: past it the pace speeds up instead.
 */
export const LABEL_TYPE_MS_PER_CHAR = 20
export const LABEL_TYPE_MAX_MS = 600

/**
 * The hover-expanded label's typing reveal: what the label shows after the
 * pointer has rested on the planet for `elapsedMs`. Starts on the truncated
 * prefix `truncateLabel` already shows (minus its ellipsis) and types the
 * rest — so the expansion reads as the ellipsis unfolding, not a swap.
 */
export function typedLabel(title: string, elapsedMs: number): string {
  if (title.length <= LABEL_MAX_CHARS) return title
  const base = title.slice(0, LABEL_MAX_CHARS - 1).trimEnd().length
  const remaining = title.length - base
  const duration = Math.min(remaining * LABEL_TYPE_MS_PER_CHAR, LABEL_TYPE_MAX_MS)
  const progress = Math.min(Math.max(elapsedMs / duration, 0), 1)
  return title.slice(0, base + Math.floor(progress * remaining))
}

/** Planet label sizes as the canvas draws them: 11px mono title, 9.5px family line. */
const LABEL_TITLE_PX = 11
const LABEL_FAMILY_PX = 9.5
/** Type floors from canvas 5a — "hairlines and type floors do not [scale] (10 px mono minimum)". */
const LABEL_TITLE_FLOOR_PX = 10
const LABEL_FAMILY_FLOOR_PX = 9.5

/** The title line's `letter-spacing` in `Planet`'s label, in em. */
export const LABEL_TITLE_TRACKING_EM = 0.06
/** The family line's `letter-spacing`, in em (canvas 4a: `.1em`). */
export const LABEL_FAMILY_TRACKING_EM = 0.1
/** Gap between the title and the family line, CSS px (canvas 4a: 5px below the title). */
export const LABEL_FAMILY_GAP_PX = 5
/** JetBrains Mono is monospaced: every glyph advances 600/1000 of an em. */
const MONO_ADVANCE_EM = 0.6
/**
 * JetBrains Mono's `line-height: normal`, in em: its ascender plus
 * descender (1020 + 300 per 1000 units, no line gap). Every line of map
 * text is laid out at this height, since none of them sets its own.
 */
const MONO_LINE_HEIGHT_EM = 1.32

/** CSS px of one line of mono text: `chars` glyphs, each an advance plus the tracking. */
function monoWidthPx(chars: number, fontPx: number, trackingEm: number): number {
  return chars * fontPx * (MONO_ADVANCE_EM + trackingEm)
}


/**
 * The box a planet's resting label occupies, in CSS px: the truncated title
 * over the family line, laid out as `Planet` lays them out. The simulation
 * keeps neighbours clear of it (`planetOutline` in `simulation.ts`), so a
 * change to the label's type has to be made through the constants above for
 * the spacing to follow.
 */
export function restingLabelSizePx(
  title: string,
  family: string | null,
  font: { title: number; family: number }
): { width: number; height: number } {
  const titleWidth = monoWidthPx(truncateLabel(title).length, font.title, LABEL_TITLE_TRACKING_EM)
  const titleHeight = font.title * MONO_LINE_HEIGHT_EM
  if (!family) return { width: titleWidth, height: titleHeight }
  return {
    width: Math.max(titleWidth, monoWidthPx(family.length, font.family, LABEL_FAMILY_TRACKING_EM)),
    height: titleHeight + LABEL_FAMILY_GAP_PX + font.family * MONO_LINE_HEIGHT_EM,
  }
}

// --- What hangs off the hole -------------------------------------------------
// The corner hole's label column (canvas 4a's hole block), here rather than
// in `Hole.tsx` for the same reason as the planet's: the simulation keeps
// bonded bodies out of it and must stay free of three.js. Canvas 4a draws
// the hole in px at 34 px = 1 world unit, the conversion `simulation.ts`
// uses too; the offsets below are in the hole's local units, before the
// counter-zoom `Hole` draws it with.

/** Canvas 4a px → hole-local units. */
const holePx = (canvasPx: number) => canvasPx / 34

/** The event horizon: canvas draws a 50px disc. Constant size — open question 3 resolved as "constant". */
export const HOLE_RADIUS = holePx(25)
/** Label column offset: canvas puts it `right: calc(100% + 26px)`. */
export const HOLE_LABEL_GAP = holePx(26)

/** The label column's three lines: title, count, drop hint — mono, px and em tracking. */
export const HOLE_TITLE_FONT_PX = 10
export const HOLE_TITLE_TRACKING_EM = 0.2
export const HOLE_COUNT_FONT_PX = 10
export const HOLE_COUNT_TRACKING_EM = 0.06
export const HOLE_HINT_FONT_PX = 9.5
export const HOLE_HINT_TRACKING_EM = 0.06
/** The column's flex `gap`, CSS px. */
export const HOLE_LABEL_LINE_GAP_PX = 4
/**
 * The title names what a click opens, not what a drop does: the trash is
 * still the way into the sidebar's HISTORY (spec
 * 2026-09-24-sessions-end-only-by-hand-design § 3).
 */
export const HOLE_TITLE = 'HISTORY'
/**
 * Hint copy per drop state (spec 2026-09-24-sessions-end-only-by-hand-design
 * § 3). Placeholder wording until Claude Design draws the trash; the
 * refused line is the only one that has to say why nothing happens.
 */
export const HOLE_HINT_REST = 'drop a session here to end it'
export const HOLE_HINT_ARMED = 'release to end'
export const HOLE_HINT_REFUSED = "can't end a terminal session"

/** The count line under the title. */
export function holeCountLine(count: number): string {
  return `${count} ${count === 1 ? 'session' : 'sessions'} · click to browse`
}

/**
 * The box the hole's label column occupies, CSS px: its widest line (the
 * longest of the hints counts, so the box does not change as a drag arms or
 * is refused by the trash) over three lines and two gaps.
 */
export function holeLabelSizePx(count: number): { width: number; height: number } {
  const hintChars = Math.max(HOLE_HINT_REST.length, HOLE_HINT_ARMED.length, HOLE_HINT_REFUSED.length)
  return {
    width: Math.max(
      monoWidthPx(HOLE_TITLE.length, HOLE_TITLE_FONT_PX, HOLE_TITLE_TRACKING_EM),
      monoWidthPx(holeCountLine(count).length, HOLE_COUNT_FONT_PX, HOLE_COUNT_TRACKING_EM),
      monoWidthPx(hintChars, HOLE_HINT_FONT_PX, HOLE_HINT_TRACKING_EM)
    ),
    height:
      (HOLE_TITLE_FONT_PX + HOLE_COUNT_FONT_PX + HOLE_HINT_FONT_PX) * MONO_LINE_HEIGHT_EM +
      2 * HOLE_LABEL_LINE_GAP_PX,
  }
}

/** The state pill's type and box, CSS px (artboards 1f, 24a): mono 9.5px / .1em, `padding: 3px 8px`, 1px border. */
export const STATE_PILL_FONT_PX = 9.5
export const STATE_PILL_TRACKING_EM = 0.1
export const STATE_PILL_PAD_X_PX = 8
export const STATE_PILL_PAD_Y_PX = 3
export const STATE_PILL_BORDER_PX = 1
/**
 * The dot in front of the word, and the flex gap after it (24a): NEEDS
 * INPUT's solid dot is 5px, WAITING's hollow one 6px (ring: `STATE_DOT_RING_PX`).
 */
export const STATE_PILL_DOT_PX = 5
export const STATE_PILL_HOLLOW_DOT_PX = 6
export const STATE_PILL_GAP_PX = 6
/**
 * Dot mode's resting disc (24e: "resting: 20px disc + 7px dot"): a 20px-high
 * pill, `padding: 0 6px`, holding only the dot. The word slides out of it on
 * hover, `margin-left` opening to the same 6px gap as label mode.
 */
export const STATE_DISC_HEIGHT_PX = 20
export const STATE_DISC_PAD_X_PX = 6
export const STATE_DISC_DOT_PX = 7

/**
 * The state pill's box, CSS px, as it rests on the map — the room the
 * simulation keeps for it. Label mode is the whole pill with its word and
 * dot (if any); dot mode is the resting disc, whatever the word, because the
 * hover-expanded word is allowed to overlap a neighbour (spec
 * 2026-09-24-state-colours-design § 3).
 */
export function statePillSizePx(
  label: string,
  dot: DotShape,
  mode: MapStatePills
): { width: number; height: number } {
  if (mode === 'dot') {
    return {
      width: STATE_DISC_DOT_PX + 2 * (STATE_DISC_PAD_X_PX + STATE_PILL_BORDER_PX),
      height: STATE_DISC_HEIGHT_PX,
    }
  }
  const text = monoWidthPx(label.length, STATE_PILL_FONT_PX, STATE_PILL_TRACKING_EM)
  const chrome = 2 * (STATE_PILL_PAD_X_PX + STATE_PILL_BORDER_PX)
  const dotPx = dot === 'solid' ? STATE_PILL_DOT_PX : dot === 'hollow' ? STATE_PILL_HOLLOW_DOT_PX : 0
  return {
    width: text + chrome + (dotPx > 0 ? dotPx + STATE_PILL_GAP_PX : 0),
    height: STATE_PILL_FONT_PX * MONO_LINE_HEIGHT_EM + 2 * (STATE_PILL_PAD_Y_PX + STATE_PILL_BORDER_PX),
  }
}

/**
 * Label font sizes under the Appearance settings (canvas 5a): with "Scale
 * labels with bodies" off the canvas sizes hold at every `planet_scale`;
 * with it on they multiply by the scale, floored so small scales never make
 * a name unreadable. The counter-zoom factor never enters here — it exists
 * to close the gap between a shrinking body and a fixed label.
 */
export function labelFontPx(
  planetScale: number,
  scaleLabels: boolean
): { title: number; family: number } {
  if (!scaleLabels) return { title: LABEL_TITLE_PX, family: LABEL_FAMILY_PX }
  return {
    title: Math.max(LABEL_TITLE_FLOOR_PX, LABEL_TITLE_PX * planetScale),
    family: Math.max(LABEL_FAMILY_FLOOR_PX, LABEL_FAMILY_PX * planetScale),
  }
}
