import type { StatsToolRow, StatsTotals } from '../lib/types'

/**
 * The leaderboard's two numbers per row, which are deliberately not the same
 * number (controller Ruling 15, ADR
 * `docs/decisions/leaderboard-bars-are-max-normalised.md`):
 *
 * - the **bar** is normalised to the leading row, which is the canvas's own
 *   geometry (10a draws the top row at 74% of the track and the rest in
 *   proportion to it). A bar drawn as a share of the window's whole tool time
 *   would be a stub on real data — the top tool of a busy week is a few
 *   percent of it — and the ranking the panel exists for would be unreadable.
 * - the **share label** is the honest fraction of the window's tool time. The
 *   column heading names what the label says, not how long the bar is.
 */

export type LeaderboardTab = 'slowest' | 'mostExpensive'

/** Rows shown before the rest of the endpoint's ranking has to be scrolled to (Ruling 16, canvas 10a). */
export const LEADERBOARD_VISIBLE_ROWS = 4

export interface LeaderboardBar {
  row: StatsToolRow
  /** 0–1 of the track: the leading row fills it, every other row is relative to it. */
  width: number
  /** 0–1, the fraction the label prints. */
  share: number
}

/**
 * `slowest` divides by every millisecond the window spent inside a tool —
 * including the subagent lane, whose `Agent`/`Task` calls are tool calls too,
 * so a row can never be a share of a total that excludes it.
 *
 * `mostExpensive` has no window-wide character total to divide by (the rollup
 * keeps `resultChars` per tool, and the endpoint returns only the ranking), so
 * its share is of the listed rows' own volume. Stated on screen by the
 * column heading, which changes with the tab.
 */
export function leaderboardBars(
  rows: readonly StatsToolRow[],
  tab: LeaderboardTab,
  totals: StatsTotals
): LeaderboardBar[] {
  const measure = (row: StatsToolRow) => (tab === 'slowest' ? row.ms : row.resultChars)

  const total =
    tab === 'slowest'
      ? totals.localToolMs + totals.mcpMs + totals.subagentMs
      : rows.reduce((sum, row) => sum + row.resultChars, 0)
  const peak = rows.reduce((max, row) => Math.max(max, measure(row)), 0)

  return rows.map((row) => ({
    row,
    width: peak > 0 ? measure(row) / peak : 0,
    // Capped: a rollup written by an older stats version can carry per-tool
    // time its window totals no longer account for, and a share over 1 would
    // print as "340% of tool time".
    share: total > 0 ? Math.min(1, measure(row) / total) : 0,
  }))
}
