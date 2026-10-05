import { harnessUnfinished } from '../../lib/harnessSession'
import { sessionModelLabel } from '../../lib/models'
import { formatTokens } from '../../lib/format'
import type { ApiSession, OrbitalModel, SessionHarness, Tag } from '../../lib/types'
import { homePath } from '../format'

/**
 * The ⋯ sheet's logic (spec 2026-10-05-mobile-next § 4; canvas 10i, 10j):
 * which items a session gets, what End's and Clear's confirms list, and when
 * Rename may save. Pure, so the components only draw it.
 */

/** The sheet's rows, in the canvas's order: the reversible ones, a divider, the deliberate ones. */
export type MenuItem = 'rename' | 'tag' | 'pin' | 'clear' | 'end'

export interface MenuShape {
  items: MenuItem[]
  /** A terminal session's one line on where End and Clear live instead (10j TERMINAL). */
  terminalNote: boolean
  /** The Mac sleeps: every item waits for it, drawn but inert (10j MAC ASLEEP). */
  inert: boolean
}

/**
 * Rename, tag and pin are Orbital's own labels, so every session has them.
 * Clear and End act on the session itself: a terminal session never gets
 * either, ended or not (spec § 0); End is gone once the session has ended.
 * Asleep keeps the set and makes it inert, so the sheet still shows what it
 * would offer.
 */
export function menuFor(session: Pick<ApiSession, 'source' | 'status'>, asleep: boolean): MenuShape {
  const items: MenuItem[] = ['rename', 'tag', 'pin']
  const terminal = session.source === 'terminal'
  if (!terminal) {
    items.push('clear')
    if (session.status !== 'ended') items.push('end')
  }
  return { items, terminalNote: terminal, inert: asleep }
}

/** A running task's age as canvas 10i prints it: "42m", "3h 04m". */
export function taskAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * End's "stops with it" lines (canvas 10i End confirm): the running subagents
 * as one count, then each running background task with its age. Empty when
 * nothing else runs, and the confirm then shows no list.
 */
export function endStopsLines(
  session: Pick<ApiSession, 'subagents' | 'backgroundTasks'>,
  now: number,
): string[] {
  const lines: string[] = []
  const agents = (session.subagents ?? []).filter((a) => a.state !== 'ended').length
  if (agents > 0) lines.push(`stops with it · ${agents} running subagent${agents === 1 ? '' : 's'}`)
  for (const task of session.backgroundTasks ?? []) {
    if (task.state !== 'running') continue
    lines.push(`stops with it · ▣ ${task.label} (${taskAge(now - task.startedAt)})`)
  }
  return lines
}

/**
 * Clear's "keeps" lines (canvas 10i Clear confirm): what the Mac carries into
 * the new session since Decision 7 — the folder, the tag(s), the model and
 * the permission mode, each the cleared session's own. A null model or mode
 * is the Mac's default and is named so, since the new session stays on it.
 * The context line closes the list when the session has measured one.
 */
export function clearKeepsLines(
  session: ApiSession,
  tags: readonly Tag[],
  models: OrbitalModel[],
): string[] {
  const tagNames = session.tagIds
    .map((id) => tags.find((t) => t.id === id)?.name)
    .filter((name): name is string => Boolean(name))
  const model = session.model == null ? 'default model' : sessionModelLabel(session, models)
  const mode = session.permissionMode ?? 'default mode'
  const lines = [`keeps · ${homePath(session.cwd)}`, `keeps · ${[...tagNames, model, mode].join(' · ')}`]
  if (session.contextUsedTokens != null) lines.push(`context · ${formatTokens(session.contextUsedTokens)} → 0`)
  return lines
}

/**
 * Whether Clear sends `carryHarness`: the desktop dialog's default, on
 * whenever a harness has steps left. The held harness decides when the phone
 * has read it; until then the snapshot's `harnessStep` says the same.
 */
export function carriesHarness(
  harness: SessionHarness | null | undefined,
  step: ApiSession['harnessStep'],
): boolean {
  if (harness !== undefined) return harnessUnfinished(harness)
  return step != null && step.index < step.total
}

/** Rename's Save (canvas 10j): a title with something in it, other than the one it has. */
export function canSaveTitle(draft: string, current: string): boolean {
  const next = draft.trim()
  return next.length > 0 && next !== current
}
