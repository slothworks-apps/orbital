import type { ApiSession, ChatMessage, CompactionMark, ErrorRecord } from './types'
import { sessionStateKey } from './types'
import { chipSegments } from './subagentList'

/**
 * Context compaction, as the web client reads it (spec
 * 2026-09-28-context-compaction-design). Pure: every clock arrives as an
 * argument, so the rules are testable without fake timers.
 */

/** How long a compaction runs before its elapsed-time label appears anywhere (canvas 26b, 26e). */
export const COMPACTING_LABEL_DELAY_MS = 3_000
/** The label's own fade-in once it is due (26e: "each with a 200 ms fade"). */
export const COMPACTING_LABEL_FADE_MS = 200
/** How long the map's `compacted · 186k → 22k` caption stays after a success (26e). */
export const COMPACTED_CAPTION_MS = 6_000
/** The planet's switch into and out of the compacting look (26e "start"). */
export const COMPACTING_SWITCH_MS = 300
/** 26c's locked composer: what its field says while the session compacts. */
export const COMPACTING_PLACEHOLDER = 'Compacting. You can write again when it\u2019s done.'

/** The command a manual compaction is. Matched with or without arguments. */
const COMPACT_COMMAND_RE = /^\/compact(\s|$)/

/**
 * The compaction a session's planet, sidebar row and header show, or null.
 *
 * Only Orbital's own sessions: a terminal session's compaction is known only
 * afterwards, from its transcript. It outranks working and waiting, and loses
 * to needs-input — which cannot really coincide with it, but the planet must
 * never hide a question behind it.
 */
export function compactingOf(
  session: Pick<
    ApiSession,
    'source' | 'status' | 'compacting' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents' | 'backgroundTasks'
  >,
): { startedAt: number; trigger: 'manual' | 'auto' } | null {
  if (session.source !== 'web' || session.status === 'ended' || !session.compacting) return null
  if (sessionStateKey(session) === 'needs_input') return null
  return session.compacting
}

/**
 * How visible a compaction's elapsed-time label is, 0–1: nothing for the
 * first three seconds (a short compaction ends before anything is written),
 * then a 200 ms fade in.
 */
export function compactingLabelOpacity(elapsedMs: number): number {
  const shown = (elapsedMs - COMPACTING_LABEL_DELAY_MS) / COMPACTING_LABEL_FADE_MS
  return Math.min(1, Math.max(0, shown))
}

/** Elapsed time as the timers read it: `0:14`, `2:36`, past a minute naturally. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** A token count the way the marks print it: `186k`, `1.2M`, `950`. */
export function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/**
 * How many of the session's subagents a `/compact` would run past, when this
 * send needs confirming first — or 0 when it goes straight out. Only a
 * `/compact` (with or without arguments) is ever confirmed, and only while
 * something the session launched is still running (spec § Confirmation when
 * subagents are running). The count is the header chip's running count.
 */
export function compactConfirmCount(text: string, session: Pick<ApiSession, 'subagents'> | undefined): number {
  if (!session || !COMPACT_COMMAND_RE.test(text.trim())) return 0
  return chipSegments(session.subagents).find((segment) => segment.kind === 'running')?.count ?? 0
}

/**
 * Each successful compaction's place among the session's successful ones,
 * by message id — `N OF M`, which a mark shows only once there is more than
 * one. Counted over the rows held, so an unfetched older page does not count.
 */
export function compactionOrdinals(messages: readonly ChatMessage[]): Map<string, { n: number; of: number }> {
  const ids = messages
    .filter((m) => m.role === 'compaction' && m.compaction?.outcome === 'success')
    .map((m) => m.id)
  return new Map(ids.map((id, i) => [id, { n: i + 1, of: ids.length }]))
}

/** The id of the newest failed-compaction mark held, or null. `/compact again` sits only on it. */
export function newestFailedCompactionId(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'compaction' && m.compaction?.outcome === 'failed') return m.id
  }
  return null
}

/**
 * A mark's time: the time of day for today, a date for anything older
 * (26d: `14:32`, `Sep 12, 09:05`).
 */
export function formatMarkTime(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  if (date.toDateString() === new Date(now).toDateString()) return time
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

/**
 * A duration on a mark's meta line: `38s` under a minute, `2m 36s` past it.
 * Real compactions run 74–156 s, so the minute form is the common one.
 */
export function formatMarkDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * How much of the context a compaction dropped, as the mark prints it
 * (`−88 %`), or null when it did not say what was left.
 */
export function compactionDropPercent(mark: Pick<CompactionMark, 'preTokens' | 'postTokens'>): number | null {
  if (mark.preTokens === null || mark.postTokens === null || mark.preTokens <= 0) return null
  return Math.round((1 - mark.postTokens / mark.preTokens) * 100)
}

/**
 * A failed compaction as the error log's Copy writes a record — one block
 * with the session id, time, trigger, tokens, duration and the error — so a
 * pasted failure reads the same from either place.
 */
export function compactionFailureRecord(
  sessionId: string,
  mark: CompactionMark,
  timestamp: string | undefined,
): ErrorRecord {
  return {
    id: 0,
    at: timestamp ? Date.parse(timestamp) : Date.now(),
    source: 'server',
    kind: 'compaction_failed',
    sessionId,
    message: mark.error ? `Compaction failed: ${mark.error}` : 'Compaction failed (no reason given)',
    detail: null,
    context: { trigger: mark.trigger, preTokens: mark.preTokens, durationMs: mark.durationMs },
    seenAt: null,
  }
}
