/**
 * Pure display-formatting helpers for the Sidebar's HISTORY rows (task 10).
 * Kept free of React/store imports so they're trivial to unit-test.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Formats a past epoch-ms timestamp as a short relative-time string, per
 * artboard 1a's HISTORY section ("3m", "2h", "5d"). Anything under a minute
 * reads as "now"; anything 30 days or older falls back to a short date
 * ("Jan 5") rather than an unreadable "412d".
 */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - ts)

  if (diffMs < MINUTE_MS) return 'now'

  const minutes = Math.floor(diffMs / MINUTE_MS)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(diffMs / HOUR_MS)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(diffMs / DAY_MS)
  if (days < 30) return `${days}d`

  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Shortens a working-directory path to `~/…/<second-to-last>/<last>` for
 * sidebar rows. Paths with two or fewer segments are shown in full (still
 * `~`-prefixed) since there's nothing to elide.
 */
export function shortenPath(cwd: string): string {
  const segments = cwd.split('/').filter(Boolean)
  if (segments.length <= 2) return `~/${segments.join('/')}`
  return `~/…/${segments.slice(-2).join('/')}`
}
