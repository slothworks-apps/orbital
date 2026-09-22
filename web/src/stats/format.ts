/**
 * The number formats every stats surface prints, from canvas 10e's "number
 * formats" row. One module because the dashboard, the drilldown (task 6) and
 * the quick-stats dialog (task 7) must agree to the digit — a session that
 * reads `4m 10s` on one screen and `250s` on the next is two products.
 *
 * Deliberately separate from `lib/format.ts`: that one formats ages and
 * delays for the sidebar ("3m", "6d 22h"), rounding up so a countdown never
 * reads zero. These round honestly and pad, because they are measurements.
 */

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS

/**
 * A measured span: `1.2s` under a minute, `4m 10s` under an hour, `2h 05m`
 * above it. Hours never roll into days — a window total reads `41h 12m`,
 * which is the number the tile is comparing against wall clock.
 *
 * Each branch rounds at its own granularity and re-tests the result, so a
 * span that rounds up out of its branch (59.96s) is printed by the next one
 * instead of as `60.0s`.
 */
export function formatStatsDuration(ms: number): string {
  const total = Math.max(0, ms)

  const tenths = Math.round(total / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`

  const seconds = Math.round(total / SECOND_MS)
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  }

  const minutes = Math.round(total / MINUTE_MS)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** Three significant figures, with the zeros they would pad dropped (`1.20k` reads `1.2k`). */
function significant3(value: number): string {
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2
  const fixed = value.toFixed(decimals)
  return decimals === 0 ? fixed : fixed.replace(/\.?0+$/, '')
}

export interface TokenParts {
  value: string
  unit: '' | 'k' | 'M'
}

/**
 * Token counts as 10e abbreviates them — `12.4k`, `1.2M` — split into the
 * number and its unit, because the stat tiles set the unit in its own size
 * and alpha (10a). Counts below a thousand are printed whole: there is no
 * abbreviation of 148 that is shorter than 148.
 */
export function splitTokens(tokens: number): TokenParts {
  const n = Math.round(Math.max(0, tokens))
  if (n < 1000) return { value: String(n), unit: '' }

  const thousands = n / 1000
  if (thousands < 1000) {
    const value = significant3(thousands)
    // 999.5k rounds to "1000k", which is not a unit anyone writes — let it
    // fall through and be printed as 1M.
    if (Number(value) < 1000) return { value, unit: 'k' }
  }
  return { value: significant3(n / 1_000_000), unit: 'M' }
}

export function formatTokens(tokens: number): string {
  const { value, unit } = splitTokens(tokens)
  return `${value}${unit}`
}

/** Cost to the cent, without the symbol — the tiles set the `$` separately (10a). */
export function formatCostAmount(usd: number): string {
  return usd.toFixed(2)
}

export function formatCost(usd: number): string {
  return `$${formatCostAmount(usd)}`
}

/** A 0–1 ratio as a whole percent (10e: "ratios whole %"). */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/**
 * The cost tile's window-over-window line ("+18% vs prev 7d"). The value
 * arrives from the endpoint already in percent, not as a ratio. The minus is
 * U+2212, as the canvas sets it — a hyphen reads as a dash at mono 10.5.
 */
export function formatDeltaPercent(percent: number): string {
  const rounded = Math.round(percent)
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded)}%`
}

/** The cache panel's trend line ("−9 pts this week") — a difference of two ratios. */
export function formatPoints(ratioDelta: number): string {
  const rounded = Math.round(ratioDelta * 100)
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded)} pts`
}

/**
 * A tool as the leaderboard and the findings print it: an MCP tool by server
 * and tool (`sentry.search_issues`), everything else by its bare name. The
 * wire name is `mcp__<server>__<tool>`, which is unreadable at mono 11.5 and
 * says nothing the amber MCP badge next to it does not (10a).
 *
 * A server or tool name may itself contain a single underscore, so the split
 * is on the double underscore only, and a name that does not have the two
 * separators is returned as it came.
 */
export function formatToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const rest = name.slice('mcp__'.length)
  const separator = rest.indexOf('__')
  if (separator < 0) return rest || name
  return `${rest.slice(0, separator)}.${rest.slice(separator + 2)}`
}

const HOUR_MINUTE = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
const DAY_MONTH = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

/**
 * A session's span as the drilldown's meta line prints it (10b: `18 Sep 13:04
 * → 14:41`). The end keeps its date only when the session crossed midnight,
 * which is the one case where the bare time would be ambiguous.
 *
 * An unfinished or unmeasured end is an em dash rather than "now": the stats
 * are read from what the transcript recorded, and it recorded no end.
 */
export function formatSessionSpan(firstAt: number | null, lastAt: number | null): string {
  if (firstAt === null) return '—'
  const start = `${DAY_MONTH.format(firstAt)} ${HOUR_MINUTE.format(firstAt)}`
  if (lastAt === null) return `${start} → —`
  const sameDay = new Date(firstAt).toDateString() === new Date(lastAt).toDateString()
  const end = sameDay
    ? HOUR_MINUTE.format(lastAt)
    : `${DAY_MONTH.format(lastAt)} ${HOUR_MINUTE.format(lastAt)}`
  return `${start} → ${end}`
}

/**
 * When a finding was measured, as its card's right-hand stamp reads (10a):
 * `today 14:02`, `yest 21:36`, `17 Sep`. Calendar days, not elapsed hours —
 * a finding from 23:50 last night is "yest", not "today".
 */
export function formatFindingTime(when: number, now: number = Date.now()): string {
  const startOfDay = (ms: number) => {
    const d = new Date(ms)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const days = Math.round((startOfDay(now) - startOfDay(when)) / (24 * HOUR_MS))
  if (days === 0) return `today ${HOUR_MINUTE.format(when)}`
  if (days === 1) return `yest ${HOUR_MINUTE.format(when)}`
  return DAY_MONTH.format(when)
}
