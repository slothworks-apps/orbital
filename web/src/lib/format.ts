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
 * A span of time as a delay reads, not as an age: "30m", "2h", "6d 22h".
 * `units` is how many terms it may spend — one for a setting value ("releases
 * 2h after it ended"), two for a countdown, where the hours left of the last
 * day are the part that is actually changing.
 *
 * A term that would read zero is dropped rather than padded, and anything
 * under a minute rounds up: a countdown that reads "0m" looks stopped.
 */
export function formatDuration(ms: number, units: 1 | 2 = 1): string {
  const total = Math.max(0, ms)
  const days = Math.floor(total / DAY_MS)
  const hours = Math.floor((total - days * DAY_MS) / HOUR_MS)
  const minutes = Math.floor((total - days * DAY_MS - hours * HOUR_MS) / MINUTE_MS)

  if (days > 0) return units === 2 && hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return units === 2 && minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${Math.max(1, minutes)}m`
}

/**
 * The detail panel's footer line for an ended session (canvas 4a's foot note,
 * strings from 4d): either what the pin promises, or when the session ended.
 * There is no countdown any more — an unpinned ended session is already off
 * the map (spec 2026-09-24-sessions-end-only-by-hand-design § 3).
 *
 * `null` for a session with no end time — there is no moment to date it from.
 */
export function endedFootnote({
  pinned,
  endedAt,
  now = Date.now(),
}: {
  pinned: boolean
  endedAt: number | null
  now?: number
}): string | null {
  if (pinned) return 'pinned · stays on the map until you unpin it or drop it in the trash'
  if (endedAt == null) return null

  const age = Math.max(0, now - endedAt)
  // `timeAgo` turns ancient timestamps into a date and fresh ones into "now",
  // neither of which survives being slotted into "ended … ago".
  if (age < MINUTE_MS) return 'ended just now'
  return age >= 30 * DAY_MS ? `ended on ${timeAgo(endedAt, now)}` : `ended ${timeAgo(endedAt, now)} ago`
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
 * How few characters of the path the detail header's first row will go down
 * to before it starts cutting the branch instead, and the floor and ceiling
 * the branch itself gets (canvas `Feature - Git worktree` 1f).
 *
 * The path yields first because it does not change and is echoed in the
 * planet label, the title and the tooltip, while the branch changes and is
 * shown nowhere else — and in a worktree the path's leaf usually *is* the
 * branch name, so cutting it costs almost nothing.
 */
export const WHERE_PATH_FLOOR_CH = 14
export const WHERE_BRANCH_FLOOR_CH = 10
export const WHERE_BRANCH_CAP_CH = 24

/**
 * Cuts the front off a path, snapping to a `/` so the result reads as whole
 * segments (`…/auth-service`) rather than stopping mid-name. The snap is
 * skipped when it would leave too little behind to identify the directory.
 */
export function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars < 2) return '…'
  let tail = text.slice(-(maxChars - 1))
  const slash = tail.indexOf('/')
  if (slash > 0 && tail.length - slash >= 6) tail = tail.slice(slash)
  return `…${tail}`
}

/**
 * Cuts a branch name in the middle, keeping its prefix and its tail — the
 * tail being the part that tells one branch from another
 * (`feature/int…questions`).
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars < 2) return '…'
  const head = Math.ceil((maxChars - 1) / 2)
  const tail = maxChars - 1 - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/**
 * Splits the header row's first line between the path and the branch.
 * `roomChars` is what is left for the two of them together, once the mark and
 * its gaps are taken off.
 *
 * Both are shown whole when they fit. Otherwise the path yields down to
 * `WHERE_PATH_FLOOR_CH`, then the branch yields down to
 * `WHERE_BRANCH_FLOOR_CH` — and the branch never takes more than
 * `WHERE_BRANCH_CAP_CH` even when there is room to spare, so a long name
 * cannot eat the path.
 */
export function splitWhereRow(
  path: string,
  branch: string,
  roomChars: number,
): { path: string; branch: string } {
  if (!branch) return { path: truncateHead(path, roomChars), branch: '' }
  if (path.length + branch.length <= roomChars) return { path, branch }
  const forBranch = Math.max(
    Math.min(branch.length, WHERE_BRANCH_FLOOR_CH),
    Math.min(branch.length, WHERE_BRANCH_CAP_CH, roomChars - Math.min(path.length, WHERE_PATH_FLOOR_CH)),
  )
  return {
    path: truncateHead(path, roomChars - forBranch),
    branch: truncateMiddle(branch, forBranch),
  }
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

/**
 * A tool call's duration, in the transcript's own units — deliberately not
 * `formatDuration` above, whose minute/hour/day scale bottoms out at "1m"
 * and would show every sub-minute tool call as the same value. Canvas 11b:
 * `0.3s` (one decimal) under ten seconds, where the decimal is the only
 * thing distinguishing a near-instant call from a merely fast one; `42s`
 * (whole seconds — a decimal nobody reads at that scale) from ten seconds up;
 * `1m 4s` from a minute up.
 *
 * `ms === undefined` (the caller's own missing-timestamp or still-running
 * check) formats to `undefined` — no duration renders — rather than to `0s`
 * or `—`. `ToolRow` and `summarizeToolRun` (`panels/TranscriptView.tsx`) both
 * hand this the same optional value for exactly that reason: a fabricated
 * `0s` would claim a duration for a call that may have taken a minute (spec
 * `2026-09-22-subagent-transcript-panel-design.md` § 7).
 *
 * Past an hour, this is also the subagent panel's elapsed header and a
 * folded run's summed duration, not just a tool call — so it gains a fourth
 * band, `2h 14m`, rather than reading `120m 3s` or `487m 12s`. Seconds are
 * dropped past an hour, the same way `formatDuration` above drops seconds
 * past a minute (ADR `tool-duration-drops-seconds-past-an-hour`).
 */
export function formatToolDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < HOUR_MS) {
    const totalSeconds = Math.round(ms / 1000)
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
  }
  const totalMinutes = Math.round(ms / MINUTE_MS)
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`
}
