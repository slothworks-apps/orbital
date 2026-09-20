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

/**
 * Byte counts as the transcript prints them — "512 B", "214 KB", "1.3 MB".
 * Moved here from `panels/ImageThumb.tsx` once the file viewer became its
 * second consumer; a display formatter belongs with the others.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  // A round megabyte count prints round — the viewer's "10 MB ceiling"
  // must not read "10.0 MB" (canvas 8d-C names sizes bare).
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
}

/**
 * Context-window sizes as the model pickers print them — "200k", "1M".
 * Distinct from `formatTokens`: this formats a round budget, not a measured
 * count, so it never shows a decimal it does not need.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}
