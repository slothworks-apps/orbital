/**
 * Token accounting shared by everything that reads a session's context
 * usage: the detail panel's INPUT/OUTPUT/CACHE READ grid and context bar,
 * and the map's context arc (spec `context-fill-arc`).
 *
 * It lives here rather than in `DetailPanel.tsx` — where it grew up —
 * because a second reader now needs the same sum, and two copies of "what
 * counts as context" is exactly how the arc and the panel would start
 * disagreeing. The server computes the same total in
 * `server/src/runner/runner.ts` (`contextUsedFromUsage`); it cannot import
 * this module across the workspace boundary, so the two are kept in step by
 * the comment on each and by the spec.
 */

export interface UsageTokens {
  input: number
  output: number
  cacheRead: number
  /** Everything billed into the context window, incl. cache creation. */
  total: number
}

/**
 * A turn's `usage` payload read into the four numbers the UI shows, or
 * `undefined` when the value is not an object at all. Missing fields count
 * as zero — a turn that reports only `input_tokens` is a real, partially
 * described turn, not an unreadable one.
 *
 * `total` deliberately includes cache reads and cache creation: a cached-in
 * token occupies the context window like any other.
 */
export function extractUsageTokens(usage: unknown): UsageTokens | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const num = (key: string) => (typeof u[key] === 'number' ? (u[key] as number) : 0)
  const input = num('input_tokens')
  const output = num('output_tokens')
  const cacheRead = num('cache_read_input_tokens')
  return {
    input,
    output,
    cacheRead,
    total: input + cacheRead + num('cache_creation_input_tokens') + output,
  }
}

/** The two percentages the arc and the context bar step their colour at. */
export interface ContextThresholds {
  warn: number
  critical: number
}

/** Where a fill sits against the thresholds — the arc's and the bar's colour. */
export type ContextLevel = 'ok' | 'warn' | 'critical'

/**
 * An oklch colour as its three components, so a CSS string and a
 * `THREE.Color` can be produced from ONE transcription of the canvas value
 * (`setOklchTagColor` in `Planet.tsx` takes exactly these).
 */
export interface Oklch {
  lightness: number
  chroma: number
  hue: number
}

/** Past the first threshold — canvas 1i's `oklch(80% .13 60)` amber. */
export const CONTEXT_WARN_OKLCH: Oklch = { lightness: 0.8, chroma: 0.13, hue: 60 }
/** Past the second — canvas 1i's `oklch(72% .17 25)` red. */
export const CONTEXT_CRITICAL_OKLCH: Oklch = { lightness: 0.72, chroma: 0.17, hue: 25 }

/** The same colour as a CSS `oklch()` string, for the DOM half (the detail panel's bar). */
export function oklchCss({ lightness, chroma, hue }: Oklch, alpha?: number): string {
  const base = `oklch(${lightness * 100}% ${chroma} ${hue}`
  return alpha === undefined ? `${base})` : `${base} / ${alpha})`
}

/**
 * Which colour band a fill (0–1) falls in.
 *
 * The boundaries are exclusive on the way up, which is what canvas 1i says
 * in words ("≤ 50 % — tag hue", "> 50 % — amber", "> 80 % — red"): a session
 * sitting exactly ON a threshold has not crossed it yet. Compared in
 * percent, the unit the thresholds are configured and displayed in, so "50"
 * means the same thing here as it does in the settings field.
 */
export function contextLevel(fraction: number, thresholds: ContextThresholds): ContextLevel {
  const percent = fraction * 100
  if (percent > thresholds.critical) return 'critical'
  if (percent > thresholds.warn) return 'warn'
  return 'ok'
}
