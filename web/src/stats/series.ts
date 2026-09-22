import type { StatsDayBusy } from '../lib/types'

/**
 * The per-day chart needs a column for every day in the window, not only for
 * the days that happened to have sessions: the overview returns a sparse
 * series (`window.ts` buckets by `lastAt`), and drawing it as-is would put
 * Monday next to Friday with nothing between them and make the week read as
 * busier than it was.
 */

/** Widest the chart is filled out. Past this the columns are too thin to read,
 * so an `all` window spanning years shows only the days it measured. */
const MAX_DAY_COLUMNS = 45

/** Local `YYYY-MM-DD`, the key `server/src/stats/window.ts` buckets by. */
function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** A day key back to local midnight — `new Date('2026-09-14')` would parse as UTC. */
function dayStart(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function emptyDay(day: string): StatsDayBusy {
  return { day, apiMs: 0, localToolMs: 0, mcpMs: 0, subagentMs: 0, busyMs: 0 }
}

/**
 * The window's days in order, each carrying its measured busy time or zeros.
 *
 * `windowStart` is null for `window=all`, which has no beginning of its own —
 * the series then starts at the first day that measured anything. The range
 * always covers every measured day, even one that fell outside the requested
 * window (a session whose `lastAt` sits on the far side of a DST shift).
 */
export function fillDaySeries(
  series: StatsDayBusy[],
  windowStart: number | null,
  windowEnd: number
): StatsDayBusy[] {
  const sorted = [...series].sort((a, b) => a.day.localeCompare(b.day))
  const measuredFirst = sorted[0]?.day
  const measuredLast = sorted[sorted.length - 1]?.day

  const windowStartKey = windowStart === null ? measuredFirst : dayKey(new Date(windowStart))
  if (windowStartKey === undefined) return sorted

  const startKey =
    measuredFirst !== undefined && measuredFirst < windowStartKey ? measuredFirst : windowStartKey
  const windowEndKey = dayKey(new Date(windowEnd))
  const endKey =
    measuredLast !== undefined && measuredLast > windowEndKey ? measuredLast : windowEndKey
  if (endKey < startKey) return sorted

  const byDay = new Map(sorted.map((d) => [d.day, d]))
  const out: StatsDayBusy[] = []
  const cursor = dayStart(startKey)
  for (let key = startKey; key <= endKey; key = dayKey(cursor)) {
    out.push(byDay.get(key) ?? emptyDay(key))
    if (out.length > MAX_DAY_COLUMNS) return sorted
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}
