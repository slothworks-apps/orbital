import type { ApiSession, ChatMessage } from './types'
import { ApiError } from './api'
import { formatToolDuration } from './format'
import { kindWord } from './backgroundTasks'

/**
 * Rewind's pure model (spec 2026-09-29-rewind-design; canvas `Feature -
 * Rewind v2` 27a–27c): which rows can be picked, what the stop dialog asks
 * before a pick goes through, and how the server's refusals read. The count,
 * N, is computed over the transcript's rendered groups, so it lives with the
 * folding it depends on: `rewindCountFrom` in `panels/TranscriptView`.
 */

/** Sent as a whole message, it opens pick mode instead of reaching the agent (spec § Behaviour 1). */
export const REWIND_COMMAND = '/rewind'

export function isRewindCommand(text: string): boolean {
  return text.trim() === REWIND_COMMAND
}

/**
 * The ids of the held rows pick mode offers (spec § Which messages can be
 * picked). The server decides for every row it read from the file and marks
 * it `rewindable`. The one row it cannot mark is the turn this tab sent a
 * moment ago — the Runner never publishes the user's own turn, so it exists
 * only as the optimistic `local:` copy until the transcript is read again.
 * That one is offered once it has the uuid the send route answered with, and
 * only when it is not the session's first turn: some reply sits before it
 * (the server's rule is "an assistant entry or a compaction before it").
 */
export function rewindTargetIds(messages: readonly ChatMessage[]): Set<string> {
  const ids = new Set<string>()
  let replied = false
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.rewindable) ids.add(m.id)
      else if (m.id.startsWith('local:') && m.uuid && replied) ids.add(m.id)
    }
    if (m.role === 'assistant' || (m.role === 'compaction' && m.compaction?.outcome === 'success')) {
      replied = true
    }
  }
  return ids
}

/** One line of the stop dialog's list (canvas 27c, WHEN THE STOP DIALOG ASKS). */
export interface RewindConfirmItem {
  glyph: string
  kind: string
  label: string
  elapsed?: string
}

export interface RewindConfirmation {
  eyebrow: string
  title: string
  body: string
  items: RewindConfirmItem[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * What the stop dialog says before a pick goes through, or null when nothing
 * runs and the rewind happens at once (canvas 27c's four rows). The count
 * covers background tasks and subagents; the turn itself is covered by
 * "stop the session".
 *
 * `turn` is the tool call the turn is on, if any, already labelled by the
 * caller — the label is the transcript's (`salientInput`), which lives with
 * the rows.
 */
export function rewindConfirmation(
  session: Pick<ApiSession, 'status' | 'title' | 'subagents' | 'backgroundTasks'>,
  turn: { label: string; startedAt?: number } | null,
  nowMs: number,
): RewindConfirmation | null {
  const working = session.status === 'working'
  const tasks = (session.backgroundTasks ?? []).filter((t) => t.state === 'running')
  const agents = session.subagents.filter((s) => s.state !== 'ended')
  const count = tasks.length + agents.length
  if (!working && count === 0) return null

  const since = (startedAt: number | undefined) =>
    startedAt === undefined ? undefined : formatToolDuration(Math.max(0, nowMs - startedAt))
  const items: RewindConfirmItem[] = [
    ...(working && turn ? [{ glyph: '⚙', kind: 'turn', label: turn.label, elapsed: since(turn.startedAt) }] : []),
    ...tasks.map((t) => ({ glyph: '▣', kind: kindWord(t), label: t.command ?? t.label, elapsed: since(t.startedAt) })),
    ...agents.map((a) => ({ glyph: '◐', kind: 'agent', label: a.name, elapsed: since(a.startedAt) })),
  ]

  if (working) {
    const name = session.title?.trim() || 'the session'
    return {
      eyebrow: 'SESSION IS WORKING',
      title: count > 0 ? `Stop the session and end ${plural(count, 'task')}?` : 'Stop the session and rewind?',
      body: `Rewinding stops ${name} mid-turn and discards the partial reply.${count > 0 ? ' These end with it:' : ''}`,
      items,
    }
  }
  return {
    eyebrow: `${plural(count, 'task').toUpperCase()} RUNNING`,
    title: `End ${count} running ${count === 1 ? 'task' : 'tasks'} and rewind?`,
    body:
      count === 1
        ? 'The turn is over, but this task is still running. Rewinding stops the session, and it ends with it.'
        : 'The turn is over, but these tasks are still running. Rewinding stops the session, and they end with it.',
    items,
  }
}

/** The error code a rewind route answered with, read off the JSON body the `ApiError` carries. */
function errorCode(err: unknown): { code?: string; message?: string } {
  if (!(err instanceof ApiError)) return {}
  try {
    const body = JSON.parse(err.message) as { error?: unknown; message?: unknown }
    return {
      code: typeof body.error === 'string' ? body.error : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
    }
  } catch {
    return {}
  }
}

/** What the toast says when the server turns a pick down (spec § API). */
export function rewindStartFailure(err: unknown): string {
  const { code, message } = errorCode(err)
  switch (code) {
    case 'terminal_session':
      return 'A terminal holds this session now. Rewind it from there.'
    case 'rewind_pending':
      return 'A rewind is already pending in this session.'
    case 'not_rewindable':
      return 'That message can no longer be rewound to. Nothing changed.'
    case 'stop_timeout':
      return message ?? 'The session did not stop in time, so nothing was rewound.'
    default:
      return err instanceof Error && err.message ? err.message : 'The rewind failed. Nothing changed.'
  }
}

/** Whether a Cancel was answered "there is nothing pending" — already sent, cancelled elsewhere, or refused. */
export function nothingPending(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && errorCode(err).code === 'no_rewind_pending'
}

/** The refusal toast's sentence (canvas 27c, REFUSAL). */
export const REWIND_REFUSED_TOAST =
  'The CLI refused the rewind. The conversation is back as it was, and your edit is still in the composer.'
