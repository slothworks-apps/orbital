import type { ApiSession, BackgroundTask, Subagent } from './types'

/**
 * The list and its upserts carry a session's state, not its history: only
 * the subagents and background tasks running now (the server's
 * `listedSubagents` and `listedBackgroundTasks`). `GET /api/sessions/:id`
 * carries every one the session has had. These fold the two together, so the
 * session the user has open keeps its history while upserts keep arriving.
 */

/** What both kinds share, and all the merge needs. */
interface Item {
  id: string
  startedAt: number
}

export const taskRuns = (task: BackgroundTask): boolean => task.state === 'running'
export const agentRuns = (agent: Subagent): boolean => agent.state !== 'ended'

/**
 * `next` (a listed shape) with the ended items `held` knows and `next` leaves
 * out, in start order. An ended item never changes again, so the held copy is
 * still the truth. A held running item `next` no longer lists has ended, and
 * how is only in the detail (`endedOutOfList`), so it goes.
 */
export function mergeListed<T extends Item>(held: T[] | undefined, next: T[] | undefined, runs: (item: T) => boolean): T[] | undefined {
  if (!held?.length) return next
  const listed = new Set((next ?? []).map((item) => item.id))
  const kept = held.filter((item) => !runs(item) && !listed.has(item.id))
  if (kept.length === 0) return next
  return [...kept, ...(next ?? [])].sort((a, b) => a.startedAt - b.startedAt)
}

/** An item held as running that `next` no longer lists has ended, and how it ended is only in the detail. */
export function endedOutOfList<T extends Item>(held: T[] | undefined, next: T[] | undefined, runs: (item: T) => boolean): boolean {
  const listed = new Set((next ?? []).map((item) => item.id))
  return (held ?? []).some((item) => runs(item) && !listed.has(item.id))
}

/** `next` with the ended subagents and tasks `held` knows (`mergeListed`); `next` itself when there are none. */
export function withHeldHistory(held: ApiSession | undefined, next: ApiSession): ApiSession {
  const subagents = mergeListed(held?.subagents, next.subagents, agentRuns) ?? []
  const backgroundTasks = mergeListed(held?.backgroundTasks, next.backgroundTasks, taskRuns)
  if (subagents === next.subagents && backgroundTasks === next.backgroundTasks) return next
  return { ...next, subagents, backgroundTasks }
}

/** Whether something `held` showed as running has dropped out of `next`: the session's history needs reading again. */
export function historyEndedOutOfList(held: ApiSession | undefined, next: ApiSession): boolean {
  return (
    endedOutOfList(held?.subagents, next.subagents, agentRuns) ||
    endedOutOfList(held?.backgroundTasks, next.backgroundTasks, taskRuns)
  )
}

/**
 * `current` with the history `detail` (`GET /api/sessions/:id`) carries. The
 * detail is the truth about what ended; what `current` lists as running
 * stays, since an upsert may have landed while the detail was in flight.
 * Ended items only `current` held are dropped: after a Mac restart the
 * detail no longer knows a finished subagent, and neither can its buffer.
 */
export function withDetailHistory(current: ApiSession, detail: ApiSession): ApiSession {
  return {
    ...current,
    subagents: mergeListed(detail.subagents, current.subagents.filter(agentRuns), agentRuns) ?? [],
    backgroundTasks: mergeListed(detail.backgroundTasks, current.backgroundTasks?.filter(taskRuns), taskRuns),
  }
}
