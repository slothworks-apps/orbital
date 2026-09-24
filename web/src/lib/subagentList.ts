import type { Subagent } from './types'

/**
 * The subagent list's model (spec 2026-09-24-subagent-list-design.md §§ 1,
 * 2): what the detail header's chip counts, how the dropdown groups and
 * orders its rows, and what one row reads. Pure — the clock arrives as
 * `nowMs`, so the component owns the ticking and this stays testable
 * without fake timers.
 *
 * "Running" is `state !== 'ended'` throughout, the same line
 * `taskStateFor` and the map draw: every live state is still going.
 */

export type ChipSegment = { kind: 'running' | 'done' | 'failed'; count: number }

export type ListGroup = { key: 'running' | 'done'; heading: string; rows: Subagent[] }

const isRunning = (subagent: Subagent) => subagent.state !== 'ended'

/**
 * The chip's counts, in the order it reads them: running, done, failed.
 * Done holds completed, stopped and status-less agents alike — stopped is a
 * choice, not a failure, so it gets no segment of its own (spec § 1). A
 * zero segment is dropped, so an empty list is `[]` and draws no chip.
 */
export function chipSegments(subagents: readonly Subagent[]): ChipSegment[] {
  let running = 0
  let done = 0
  let failed = 0
  for (const subagent of subagents) {
    if (isRunning(subagent)) running += 1
    else if (subagent.status === 'failed') failed += 1
    else done += 1
  }
  const segments: ChipSegment[] = [
    { kind: 'running', count: running },
    { kind: 'done', count: done },
    { kind: 'failed', count: failed },
  ]
  return segments.filter((segment) => segment.count > 0)
}

/**
 * The dropdown's groups: RUNNING by `startedAt` newest first, then DONE —
 * every finished state, failed included — by `endedAt` newest first
 * (spec § 2). An ended agent without `endedAt` sorts after every stamped
 * one, by `startedAt` newest first. Ties keep input order (the sort is
 * stable). A group with no rows is omitted.
 */
export function listGroups(subagents: readonly Subagent[]): ListGroup[] {
  const running = subagents.filter(isRunning).sort((a, b) => b.startedAt - a.startedAt)
  const done = subagents
    .filter((subagent) => !isRunning(subagent))
    .sort((a, b) => {
      if (a.endedAt !== undefined && b.endedAt !== undefined) return b.endedAt - a.endedAt
      if (a.endedAt !== undefined) return -1
      if (b.endedAt !== undefined) return 1
      return b.startedAt - a.startedAt
    })
  const groups: ListGroup[] = [
    { key: 'running', heading: `RUNNING · ${running.length}`, rows: running },
    { key: 'done', heading: `DONE · ${done.length}`, rows: done },
  ]
  return groups.filter((group) => group.rows.length > 0)
}

/**
 * The word a row prints after its type: nothing while running (the
 * breathing dot says it), else how it finished. No status reads `done` —
 * the retirement path ends an agent without one, and it did finish.
 */
export function rowStateWord(subagent: Subagent): '' | 'done' | 'failed' | 'stopped' {
  if (isRunning(subagent)) return ''
  if (subagent.status === 'failed') return 'failed'
  if (subagent.status === 'stopped') return 'stopped'
  return 'done'
}

/**
 * A row's elapsed ms: running ticks against `nowMs`, finished freezes at
 * `endedAt` (spec § 3). `undefined` — never a fabricated number — for a
 * finished agent the server never stamped; the list has no buffer to fall
 * back on the way the panel's `elapsedMsFor` does.
 */
export function rowElapsedMs(subagent: Subagent, nowMs: number): number | undefined {
  if (isRunning(subagent)) return Math.max(0, nowMs - subagent.startedAt)
  if (subagent.endedAt === undefined) return undefined
  return Math.max(0, subagent.endedAt - subagent.startedAt)
}

/**
 * Whether a row can open the agent's transcript: without a `toolUseId`
 * nothing joins it to a buffer (subagent panel spec § 5), so its row stays
 * listed, dimmed and disabled.
 */
export function isOpenable(subagent: Subagent): boolean {
  return Boolean(subagent.toolUseId)
}
