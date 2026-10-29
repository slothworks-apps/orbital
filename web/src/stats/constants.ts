import { swatch } from '../lib/palette'
import type { FindingSeverity } from '../lib/types'

/**
 * Every value the stats screens share, transcribed from canvas 10e's tables.
 *
 * Literals rather than theme tokens: these four chart hues are chart-only and
 * are deliberately NOT the app's palette — 10e reserves the tag hues for tags
 * and keeps these off the map entirely. Putting them in `theme.css` would
 * invite exactly the reuse the canvas rules out. They live here as one
 * module so the dashboard, the drilldown and the quick dialog cannot drift.
 */

/** Which field of a totals/day-series row a category reads. */
export type TimeCategoryField = 'apiMs' | 'localToolMs' | 'mcpMs' | 'subagentMs'

export interface TimeCategory {
  field: TimeCategoryField
  /** As the tile legend and the tooltip spell it (10a). */
  label: string
  color: string
}

/**
 * Exactly four, mutually exclusive, summing to busy time (10e). The order is
 * the stacking order from the base up: API wait is always the base of a
 * stack, which is what makes two days comparable at a glance.
 */
export const TIME_CATEGORIES: readonly TimeCategory[] = [
  { field: 'apiMs', label: 'API wait', color: swatch('accent') },
  { field: 'localToolMs', label: 'local tools', color: '#b18cff' },
  { field: 'mcpMs', label: 'MCP', color: swatch('warning') },
  { field: 'subagentMs', label: 'subagents', color: '#67e0a3' },
]

/** The unfilled part of any bar — never labelled, never in a legend (10e). */
export const TRACK_COLOR = swatch('line', 0.07)

/** A leaderboard row's bar takes its category colour from the tool's kind (10a). */
export const MCP_COLOR = swatch('warning')
export const LOCAL_TOOL_COLOR = '#b18cff'

export interface SeverityStyle {
  /** The chip's ink, and the card's 2px inset stripe. */
  ink: string
  stripe: string
  cardBorder: string
  /** The card's own fill — RESOLVED sits back further than the other three (10d). */
  cardFill: string
  chipFill: string
  chipBorder: string
  /** RESOLVED alone is dimmed as a whole (10d). */
  opacity?: number
}

/** The fill the three live treatments share (10d). */
const CARD_FILL = swatch('shade', 0.45)

/** 10e's severity table, value for value. */
export const SEVERITY_STYLES: Record<FindingSeverity, SeverityStyle> = {
  critical: {
    ink: swatch('danger-soft'),
    stripe: swatch('danger-soft'),
    cardBorder: swatch('danger-soft', 0.35),
    cardFill: CARD_FILL,
    chipFill: swatch('danger-soft', 0.16),
    chipBorder: swatch('danger-soft', 0.5),
  },
  warning: {
    ink: swatch('warning'),
    stripe: swatch('warning'),
    cardBorder: swatch('warning', 0.3),
    cardFill: CARD_FILL,
    chipFill: swatch('warning', 0.14),
    chipBorder: swatch('warning', 0.45),
  },
  info: {
    ink: swatch('ink-900'),
    stripe: swatch('line', 0.35),
    cardBorder: swatch('line', 0.14),
    cardFill: CARD_FILL,
    chipFill: swatch('line', 0.08),
    chipBorder: swatch('line', 0.28),
  },
  resolved: {
    ink: swatch('ink-900', 0.6),
    stripe: swatch('line', 0.18),
    cardBorder: swatch('line', 0.1),
    // Thinner than the other three, on top of the .55 opacity: a resolved
    // finding is a record, not a thing to act on (10d).
    cardFill: swatch('shade', 0.3),
    chipFill: 'transparent',
    chipBorder: swatch('line', 0.18),
    opacity: 0.55,
  },
}

/** Panel chrome shared by every card on the dashboard (10a). */
export const PANEL_CLASS =
  'rounded-[14px] border border-line/14 bg-[linear-gradient(180deg,color-mix(in_oklab,_var(--color-panel-solid)_72%,_transparent),color-mix(in_oklab,_var(--color-space-deep)_80%,_transparent))]'

/** The 10px/.18em mono heading every panel and tile is titled with (10e stat tile). */
export const PANEL_LABEL_CLASS =
  'font-mono fs-10 tracking-[0.18em] text-ink-900/60'

/** Widest a day column is drawn (10e "day bar"); narrower windows shrink to fit. */
export const DAY_BAR_MAX_WIDTH = 46
/** Minimum gap kept between day columns once they start shrinking. */
export const DAY_BAR_MIN_GAP = 8
/** Plot height of the per-day chart, above the axis (10e). */
export const DAY_PLOT_HEIGHT = 170
/** Plot height of the cache-ratio trend (10a). */
export const CACHE_PLOT_HEIGHT = 78

/** The cache-hit target the trend draws its guide at (10a: "target ≥ 80%"). */
export const CACHE_TARGET_RATIO = 0.8

/**
 * One leaderboard row plus the gap under it, in px — what the visible-row cap
 * is multiplied by to bound the scroller (Ruling 16). Derived from 10a's own
 * panel: four rows and their gaps fill its plot, and a cap of exactly that
 * many rows would hide the scroll rather than hint at it, so the extra pixels
 * let the fifth row show under the fade.
 */
export const LEADERBOARD_ROW_PITCH = 26

/**
 * Mirrors of `server/src/stats/constants.ts`, which the browser cannot
 * import. Only the two the RESOLVED card states in words, and the estimator
 * the leaderboard's "most expensive" column prints — every other threshold
 * stays server-side. They must move together with the server's.
 */
export const RESOLVED_CLEAN_SESSIONS = 5
export const RESOLVED_TTL_DAYS = 7
export const CHARS_PER_TOKEN = 4

/**
 * Waiting on the user (10e): not a fifth category, so no fill colour — the
 * neutral hatch of the track/idle family, and a dashed outline where only a
 * count is shown.
 */
export const WAIT_HATCH =
  'repeating-linear-gradient(135deg,color-mix(in oklab, var(--color-ink-900) 60%, transparent) 0 1px,transparent 1px 3px)'
export const WAIT_OUTLINE = swatch('ink-900', 0.6)
