/**
 * The progress list as the web shows it (spec 2026-11-09-progress-list-design;
 * canvas `Feature - Progress list` 67b–67e): the session's transcript folded
 * into the list, when each item came and went, and the rows the transcript
 * draws for it. The fold of one call is `@orbital/shared/progress`'s, the same
 * the server and the phone use; this adds the transcript around it — which
 * calls the tool accepted, and when.
 */

import {
  PROGRESS_TOOL,
  applyProgressCall,
  progressFigure,
  readProgressCall,
  type ProgressChange,
  type ProgressItem,
} from '@orbital/shared/progress'
import type { ChatMessage } from './types'

/** An item of the current list, with when a later call added or dropped it. */
export interface ProgressListItem extends ProgressItem {
  /** Added by a call after the list was written. */
  addedAt?: number
  /** Dropped by a call after the list was written. */
  droppedAt?: number
}

/** The current list: the items and the times its header says. */
export interface ProgressList {
  items: ProgressListItem[]
  /** When the agent wrote it: the session's first list, or a new list for a new task. */
  writtenAt: number | null
  /** The last call that added or dropped items; null while none has. */
  changedAt: number | null
  /** The call after which every counted item was done; null while one is not. */
  finishedAt: number | null
}

/** A transcript row of the list (67d), as `ProgressTranscriptRow` draws it. */
export type ProgressRow =
  /** The session's first list, as the agent wrote it. */
  | { kind: 'written'; items: ProgressItem[] }
  /** Items added or dropped, and the agent's reason. */
  | { kind: 'changed'; added: string[]; dropped: { title: string; reason?: string }[]; reason?: string }
  /** A new list for a new task; `previous` as it ended. */
  | { kind: 'new_list'; items: ProgressItem[]; previous: ProgressItem[]; reason?: string }
  /** A harness was attached: the list as it stays. Orbital's row, not the agent's. */
  | { kind: 'frozen'; items: ProgressListItem[] }

/** What the fold read off one accepted call. */
interface Accepted {
  change: ProgressChange
  at: number | null
  /** The call's own reason, which a new list's row says too. */
  reason?: string
}

export interface ProgressFold {
  /** The current list, or null while the transcript held carries none. */
  list: ProgressList | null
  /** Every accepted call, by its tool_use message id. */
  calls: ReadonlyMap<string, Accepted>
  /** The tool's calls the transcript does not show: state changes, and calls still waiting for their answer. */
  hidden: ReadonlySet<string>
}

const timeOf = (m: ChatMessage): number | null => {
  const t = m.timestamp ? Date.parse(m.timestamp) : Number.NaN
  return Number.isNaN(t) ? null : t
}

/**
 * Folds the tool's calls in `messages` (oldest first) into the current list.
 * Only a call with an answer that is not an error counts (spec § How the Mac
 * keeps it): a refused call stays in the transcript as the tool row it is,
 * and a call still waiting for its answer shows nothing until it has one.
 */
export function foldProgress(messages: readonly ChatMessage[]): ProgressFold {
  const results = new Map<string, ChatMessage>()
  for (const m of messages) if (m.role === 'tool_result' && m.toolUseId) results.set(m.toolUseId, m)

  const calls = new Map<string, Accepted>()
  const hidden = new Set<string>()
  let list: ProgressList | null = null
  for (const m of messages) {
    if (m.role !== 'tool_use' || m.toolName !== PROGRESS_TOOL) continue
    const result = m.toolUseId ? results.get(m.toolUseId) : undefined
    if (!result) {
      hidden.add(m.id)
      continue
    }
    const call = readProgressCall(m.toolInput)
    if (result.isError || call === null) continue
    const at = timeOf(m)
    const { items, change } = applyProgressCall(list?.items ?? null, call)
    calls.set(m.id, { change, at, ...(call.reason !== undefined ? { reason: call.reason } : {}) })
    if (change.kind === 'ticked') hidden.add(m.id)
    list = nextList(list, items, change, at)
  }
  return { list, calls, hidden }
}

/** The list after one call, its times carried over from the list before it. */
function nextList(before: ProgressList | null, items: ProgressItem[], change: ProgressChange, at: number | null): ProgressList {
  const fresh = change.kind === 'written' || change.kind === 'new_list'
  const old = new Map((fresh || !before ? [] : before.items).map((item) => [item.title, item]))
  const added = new Set(change.kind === 'changed' ? change.added : [])
  const dropped = new Set(change.kind === 'changed' ? change.dropped.map((d) => d.title) : [])
  const next: ProgressListItem[] = items.map((item) => {
    const prior = old.get(item.title)
    const addedAt = added.has(item.title) ? (at ?? undefined) : prior?.addedAt
    const droppedAt = dropped.has(item.title) ? (at ?? undefined) : item.state === 'dropped' ? prior?.droppedAt : undefined
    return { ...item, ...(addedAt !== undefined ? { addedAt } : {}), ...(droppedAt !== undefined ? { droppedAt } : {}) }
  })
  const { done, total } = progressFigure(next)
  const complete = total > 0 && done === total
  return {
    items: next,
    writtenAt: fresh ? at : (before?.writtenAt ?? null),
    changedAt: change.kind === 'changed' ? at : fresh ? null : (before?.changedAt ?? null),
    finishedAt: !complete ? null : !fresh && before?.finishedAt != null ? before.finishedAt : at,
  }
}

/**
 * The transcript with the list's rows in it (canvas 67d): a call that wrote,
 * changed or replaced the list becomes a `progress` row in the place of its
 * tool row, and its answer goes; a call that only moved states, or still
 * waits for its answer, goes with its answer. `frozenAt` — a harness attached
 * while the list stands — adds Orbital's frozen row after the harness's first
 * message from then on, or where the time puts it when there is none.
 */
export function withProgressRows(
  messages: readonly ChatMessage[],
  fold: ProgressFold,
  frozenAt: number | null,
): ChatMessage[] {
  if (fold.calls.size === 0 && fold.hidden.size === 0 && (frozenAt === null || fold.list === null)) {
    return messages as ChatMessage[]
  }
  const gone = new Set<string>()
  for (const m of messages) {
    if (m.role === 'tool_use' && m.toolName === PROGRESS_TOOL && m.toolUseId && (fold.calls.has(m.id) || fold.hidden.has(m.id))) {
      gone.add(m.toolUseId)
    }
  }
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'tool_result' && m.toolUseId && gone.has(m.toolUseId)) continue
    if (m.role === 'tool_use' && fold.hidden.has(m.id)) continue
    const accepted = m.role === 'tool_use' ? fold.calls.get(m.id) : undefined
    const row = accepted ? rowOf(accepted) : null
    out.push(row ? { id: m.id, role: 'progress', timestamp: m.timestamp, progressRow: row } : m)
  }
  if (frozenAt === null || fold.list === null) return out

  const frozen: ChatMessage = {
    id: 'progress:frozen',
    role: 'progress',
    timestamp: new Date(frozenAt).toISOString(),
    progressRow: { kind: 'frozen', items: fold.list.items },
  }
  // The harness's kickoff is stamped a moment after it was attached.
  const kickoff = out.findIndex((m) => (m.role === 'harness' || m.harnessMessage) && (timeOf(m) ?? -Infinity) >= frozenAt - KICKOFF_SLACK_MS)
  if (kickoff !== -1) {
    out.splice(kickoff + 1, 0, frozen)
    return out
  }
  const after = out.findIndex((m) => (timeOf(m) ?? -Infinity) > frozenAt)
  out.splice(after === -1 ? out.length : after, 0, frozen)
  return out
}

/** How long before the harness's own time its first row may be stamped and still be its. */
const KICKOFF_SLACK_MS = 5_000

function rowOf({ change, reason }: Accepted): ProgressRow | null {
  switch (change.kind) {
    case 'written':
      return { kind: 'written', items: change.items }
    case 'changed':
      return change
    case 'new_list':
      return { kind: 'new_list', items: change.items, previous: change.previous, ...(reason !== undefined ? { reason } : {}) }
    case 'ticked':
      return null
  }
}

/** `14:02`, in the user's locale. */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** The figure: done of the items that count, `3/7`. */
export function figureText(items: readonly ProgressItem[]): string {
  const { done, total } = progressFigure(items as ProgressItem[])
  return `${done}/${total}`
}

/** How many items are dropped. */
const droppedCount = (items: readonly ProgressItem[]) => items.filter((i) => i.state === 'dropped').length

/**
 * What the figure leaves out (67c's header): `1 dropped · 4 to go`, `all done
 * · 1 dropped`, and frozen `1 dropped · 4 left as they were`.
 */
export function progressSummary(items: readonly ProgressItem[], frozen: boolean): string {
  const { done, total } = progressFigure(items as ProgressItem[])
  const dropped = droppedCount(items)
  const droppedPart = dropped > 0 ? `${dropped} dropped` : null
  if (total > 0 && done === total) return ['all done', droppedPart].filter(Boolean).join(' · ')
  const left = `${total - done} ${frozen ? 'left as they were' : 'to go'}`
  return [droppedPart, left].filter(Boolean).join(' · ')
}

/** 67c's meta line: when the list was written, and last changed, finished or frozen. */
/** `frozen` without `frozenAt`: the harness that froze it is not read yet. */
export function progressMeta(list: ProgressList, frozenAt: number | null, frozen: boolean = frozenAt !== null): string {
  const written = list.writtenAt !== null ? clock(list.writtenAt) : null
  const last =
    frozen
      ? frozenAt !== null ? `frozen ${clock(frozenAt)}` : 'frozen'
      : list.finishedAt !== null
        ? `finished ${clock(list.finishedAt)}`
        : list.changedAt !== null
          ? `changed ${clock(list.changedAt)}`
          : null
  if (last === null) return written ? `written by the agent ${written}` : 'written by the agent'
  return [written ? `written ${written}` : 'written', last].join(' · ')
}

/** The small mono note under an item (67c): when it was added or dropped, or that it was in progress at the freeze. */
export function itemNote(item: ProgressListItem, frozenAt: number | null): string | null {
  if (item.state === 'dropped') return item.droppedAt !== undefined ? `dropped ${clock(item.droppedAt)}` : null
  if (frozenAt !== null && item.state === 'in_progress') return `was in progress at ${clock(frozenAt)}`
  return item.addedAt !== undefined ? `added ${clock(item.addedAt)}` : null
}

/** The pill's flyout (67b): what is in progress now, and what the figure leaves out. */
export function flyoutReading(list: ProgressList): { title: string; line: string } {
  const dropped = droppedCount(list.items)
  const droppedPart = dropped > 0 ? `${dropped} dropped` : null
  const { done, total } = progressFigure(list.items)
  if (total > 0 && done === total) {
    return {
      title: 'All done',
      line: [list.finishedAt !== null ? `finished ${clock(list.finishedAt)}` : 'finished', droppedPart].filter(Boolean).join(' · '),
    }
  }
  const now = list.items.find((i) => i.state === 'in_progress')
  const next = list.items.find((i) => i.state === 'pending')
  return {
    title: (now ?? next)?.title ?? '',
    line: [now ? 'in progress' : 'up next', droppedPart, `${total - done} to go`].filter(Boolean).join(' · '),
  }
}
