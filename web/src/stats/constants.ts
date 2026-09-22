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
  { field: 'apiMs', label: 'API wait', color: '#59e4f3' },
  { field: 'localToolMs', label: 'local tools', color: '#b18cff' },
  { field: 'mcpMs', label: 'MCP', color: '#ffbb7b' },
  { field: 'subagentMs', label: 'subagents', color: '#67e0a3' },
]

/** The unfilled part of any bar — never labelled, never in a legend (10e). */
export const TRACK_COLOR = 'rgba(150,205,255,.07)'

/** A leaderboard row's bar takes its category colour from the tool's kind (10a). */
export const MCP_COLOR = '#ffbb7b'
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
const CARD_FILL = 'rgba(4,8,16,.45)'

/** 10e's severity table, value for value. */
export const SEVERITY_STYLES: Record<FindingSeverity, SeverityStyle> = {
  critical: {
    ink: '#ff8a7a',
    stripe: '#ff8a7a',
    cardBorder: 'rgba(255,138,122,.35)',
    cardFill: CARD_FILL,
    chipFill: 'rgba(255,138,122,.16)',
    chipBorder: 'rgba(255,138,122,.5)',
  },
  warning: {
    ink: '#ffbb7b',
    stripe: '#ffbb7b',
    cardBorder: 'rgba(255,187,123,.3)',
    cardFill: CARD_FILL,
    chipFill: 'rgba(255,187,123,.14)',
    chipBorder: 'rgba(255,187,123,.45)',
  },
  info: {
    ink: '#9fc4e8',
    stripe: 'rgba(150,205,255,.35)',
    cardBorder: 'rgba(150,205,255,.14)',
    cardFill: CARD_FILL,
    chipFill: 'rgba(150,205,255,.08)',
    chipBorder: 'rgba(150,205,255,.28)',
  },
  resolved: {
    ink: 'rgba(160,190,225,.6)',
    stripe: 'rgba(150,205,255,.18)',
    cardBorder: 'rgba(150,205,255,.1)',
    // Thinner than the other three, on top of the .55 opacity: a resolved
    // finding is a record, not a thing to act on (10d).
    cardFill: 'rgba(4,8,16,.3)',
    chipFill: 'transparent',
    chipBorder: 'rgba(150,205,255,.18)',
    opacity: 0.55,
  },
}

/** Panel chrome shared by every card on the dashboard (10a). */
export const PANEL_CLASS =
  'rounded-[14px] border border-[rgba(150,205,255,.14)] bg-[linear-gradient(180deg,rgba(14,20,34,.72),rgba(8,12,22,.8))]'

/** The 10px/.18em mono heading every panel and tile is titled with (10e stat tile). */
export const PANEL_LABEL_CLASS =
  'font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]'

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
