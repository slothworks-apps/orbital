import type { EndedSummary } from '../lib/api'
import type { StateDot } from '../lib/stateStyle'
import { continuesAtReset, formatResetAt } from '../lib/limits'
import {
  gateWaits, sessionStateKey, type ApiSession, type BackgroundTask, type PendingDecision, type SessionStateKey, type Subagent, type Tag,
} from '../lib/types'
import { asOfLabel } from './format'
import { subagentStatus as subagentRowStatus, taskStatus as taskRowStatus, type RowStatus } from './subagents/model'
import { isListable } from '../lib/harnessSession'

/**
 * `pinned` is 10a's headless band of ended sessions kept above the ENDED
 * fold by their pin (spec 2026-10-05-mobile-next-design § 4).
 */
export type GroupKey = 'input' | 'working' | 'limit' | 'idle' | 'pinned' | 'ended'

/**
 * 10a's order (spec 2026-10-05-mobile-next-design § 4, § 5): what asks for
 * you first, a limit wait between WORKING and IDLE, the pinned ended rows
 * above the fold, what is over last.
 */
export const GROUP_ORDER: readonly GroupKey[] = ['input', 'working', 'limit', 'idle', 'pinned', 'ended']

/** The band's heading; the pinned band has none (canvas 10a). */
export const GROUP_LABEL: Record<GroupKey, string> = {
  input: 'NEEDS INPUT', working: 'WORKING', limit: 'WAITING FOR LIMIT', idle: 'IDLE', pinned: '', ended: 'ENDED',
}

type StateFields = Pick<
  ApiSession,
  'status' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents' | 'backgroundTasks' | 'harnessGate'
>

type GroupFields = StateFields & Pick<ApiSession, 'source' | 'limitWait' | 'pinnedAt'>

/**
 * A harness gate waiting on the user, and nothing else parked: the row that
 * wears the still diamond and the ◆ reason (canvas 10a). A parked tool call
 * outranks it, as in `headerState`.
 */
export function isGateRow(session: StateFields): boolean {
  return sessionStateKey(session) === 'needs_input' && !session.pendingDecision && gateWaits(session)
}

/**
 * Whether the row sits in WAITING FOR LIMIT: an open wait — cancelled or
 * not, the row only changes its words — on a session at rest. A terminal
 * session never has one the phone shows (spec § 8, Decision 1).
 */
export function waitsForLimit(session: GroupFields): boolean {
  if (!session.limitWait || session.source === 'terminal') return false
  const key = sessionStateKey(session)
  return key === 'idle' || key === 'done' || key === 'interrupted'
}

/**
 * The state word decides the group. WAITING is work (its moons run); DONE
 * and INTERRUPTED ask nobody anything, so they sit with IDLE, wearing their
 * own word on the row. A limit wait is its own neutral group (10a); an ended
 * session the user pinned stays out of the fold (10a, spec § 4).
 */
export function groupOf(session: GroupFields): GroupKey {
  const key = sessionStateKey(session)
  if (key === 'needs_input') return 'input'
  if (key === 'working' || key === 'waiting') return 'working'
  if (key === 'ended') return session.pinnedAt ? 'pinned' : 'ended'
  if (waitsForLimit(session)) return 'limit'
  return 'idle'
}

export interface SessionGroup {
  key: GroupKey
  sessions: ApiSession[]
}

/**
 * Within a group, pinned rows first in pin order (as the desktop's PINNED
 * section keeps it, `sidebarOrder`), then the rest newest first (spec § 4).
 */
function byPinThenActivity(a: ApiSession, b: ApiSession): number {
  const pa = a.pinnedAt ?? null
  const pb = b.pinnedAt ?? null
  if (pa !== null && pb !== null) return pa - pb
  if (pa !== null) return -1
  if (pb !== null) return 1
  return (b.lastAt ?? 0) - (a.lastAt ?? 0)
}

/** 10a's groups in order, the empty ones left out; `tagId` filters locally. */
export function groupSessions(sessions: readonly ApiSession[], tagId: number | null): SessionGroup[] {
  const buckets = new Map<GroupKey, ApiSession[]>(GROUP_ORDER.map((key) => [key, []]))
  for (const session of sessions) {
    // A harness drafting conversation is listed nowhere (`isListable`).
    if (!isListable(session)) continue
    if (tagId !== null && !session.tagIds.includes(tagId)) continue
    buckets.get(groupOf(session))!.push(session)
  }
  return GROUP_ORDER.map((key) => ({
    key,
    sessions: buckets.get(key)!.sort(byPinThenActivity),
  })).filter((group) => group.sessions.length > 0)
}

/** The collapsed ended group's "latest N ago". */
export function latestActivity(sessions: readonly ApiSession[]): number | null {
  let latest: number | null = null
  for (const session of sessions) {
    if (session.lastAt !== null && (latest === null || session.lastAt > latest)) latest = session.lastAt
  }
  return latest
}

/** The ENDED fold's header: how many, and how long ago the newest; a null count is not known. */
export interface EndedHeading {
  count: number | null
  latest: number | null
}

/**
 * The ENDED fold's header, or null when there is nothing to fold. Once the
 * fold is read — or with no summary: before the first live list, or from a
 * Mac that sent every session — it is the group as held. Before that, the
 * Mac's summary of the fold its list left out, plus the ended sessions held
 * that the summary does not count (`countedBySummary`): the ones that ended
 * while the phone watched. The summary is not per tag, so under a tag filter
 * the count is not known until the fold is read.
 */
export function endedHeading(
  group: readonly ApiSession[],
  fold: { summary: EndedSummary | null; loaded: boolean },
  countedBySummary: (id: string) => boolean,
  tagFiltered: boolean,
): EndedHeading | null {
  const { summary, loaded } = fold
  if (loaded || !summary) return group.length === 0 ? null : { count: group.length, latest: latestActivity(group) }
  if (tagFiltered) return group.length === 0 && summary.count === 0 ? null : { count: null, latest: null }
  const extra = group.filter((s) => !countedBySummary(s.id))
  const count = summary.count + extra.length
  if (count === 0) return null
  const latests = [summary.latestAt, latestActivity(extra)].filter((at): at is number => at !== null)
  return { count, latest: latests.length === 0 ? null : Math.max(...latests) }
}

/** The chips (9a): every tag some session carries, with its live — not ended — sessions counted. */
export function tagChips(sessions: readonly ApiSession[], tags: readonly Tag[]): { tag: Tag; live: number }[] {
  return tags
    .filter((tag) => sessions.some((s) => s.tagIds.includes(tag.id)))
    .map((tag) => ({ tag, live: sessions.filter((s) => s.tagIds.includes(tag.id) && s.status !== 'ended').length }))
}

/** A needs-input row's third line (9a): what the session waits on. */
export function decisionReason(decision: PendingDecision | null | undefined): string | null {
  if (!decision) return null
  if (decision.kind === 'question') return decision.input.questions[0]?.question ?? 'has a question'
  if (decision.kind === 'plan') return 'plan to approve'
  return decision.title ?? `wants to run ${decision.toolName ?? 'a tool'}`
}

/**
 * A gate row's reason (canvas 10a): ◆, then which step waits, from the
 * snapshot's `harnessStep` — its `index` is the first step not done, the
 * gated one. No elapsed time anywhere on the row: a gate can wait all night.
 */
export function gateReason(step: ApiSession['harnessStep']): string {
  if (!step || step.total === 0) return '◆ Harness · needs your OK'
  return `◆ Harness · step ${Math.min(step.index + 1, step.total)} of ${step.total} needs your OK`
}

/** A needs-input row's third line: the parked call, else the gate. */
export function inputReason(session: StateFields & Pick<ApiSession, 'harnessStep'>): string | null {
  if (session.pendingDecision) return decisionReason(session.pendingDecision)
  return isGateRow(session) ? gateReason(session.harnessStep) : null
}

/**
 * A WAITING FOR LIMIT row's third line (canvas 10a `waitListLine`, spec § 5):
 * when, which window, how many queued — absolute times only (Decision 9).
 * Asleep, a wait that would continue says it needs the Mac awake then; a
 * cancelled or auto-off wait reads the same asleep as awake. Terminal
 * sessions never have one (Decision 1).
 */
export function limitLine(
  session: Pick<ApiSession, 'limitWait' | 'source'>,
  offline: boolean,
  mac: string,
  now: number,
): string | null {
  const wait = session.limitWait
  if (!wait || session.source === 'terminal') return null
  const at = formatResetAt(wait.resetsAt, now)
  if (continuesAtReset(wait)) {
    if (offline) return `Resets at ${at} — continues only if ${mac} is awake then`
    const queued = wait.queued.length
    return `Continues at ${at} · ${wait.windowLabel}${queued > 0 ? ` · ${queued} queued` : ''}`
  }
  return `Limit resets ${at} · ${wait.cancelled ? 'auto-continue cancelled' : 'automatic continue is off'}`
}

type MoonCounts = Pick<ApiSession, 'subagents' | 'subagentCount' | 'backgroundTasks' | 'backgroundTaskCount'>

/**
 * How many subagents and tasks the session has had. The list carries only
 * the running ones, so the Mac counts the rest; a Mac from before the counts
 * sends every one, and the arrays are the count.
 */
const subagentTotal = (session: MoonCounts): number => session.subagentCount ?? session.subagents.length
const taskTotal = (session: MoonCounts): number => session.backgroundTaskCount ?? (session.backgroundTasks ?? []).length

/**
 * The list row's collapsed summary (canvas 10a), or nulls when nothing runs:
 * the list is for what is happening now, so a session whose subagents and
 * tasks have all finished shows no row there — its header chip (9b) still
 * opens every one of them.
 */
export function moonsSummary(session: MoonCounts): {
  subagents: string | null
  tasks: string | null
} {
  const agents = subagentTotal(session)
  const running = session.subagents.filter((a) => a.state !== 'ended').length
  const tasks = (session.backgroundTasks ?? []).filter((t) => t.state === 'running').length
  return {
    subagents: running === 0 ? null : `${agents} ${agents === 1 ? 'subagent' : 'subagents'} · ${running} running`,
    tasks: tasks === 0 ? null : `${tasks} ${tasks === 1 ? 'task' : 'tasks'} running`,
  }
}

/** The asleep row's one line (canvas 10a asleep): counts only, nothing about what runs. */
export function moonsSummaryAsleep(session: MoonCounts): string | null {
  const agents = subagentTotal(session)
  const tasks = taskTotal(session)
  const parts = [
    agents > 0 ? `${agents} ${agents === 1 ? 'subagent' : 'subagents'}` : null,
    tasks > 0 ? `▣ ${tasks} ${tasks === 1 ? 'task' : 'tasks'}` : null,
  ].filter((p): p is string => p !== null)
  return parts.length === 0 ? null : `${parts.join(' · ')} · last known`
}

/** The expanded rows' tasks: running first, each part newest first (as the 10f sheet orders them). */
export function tasksForRow(tasks: readonly BackgroundTask[] | undefined): BackgroundTask[] {
  return [...(tasks ?? [])].sort((a, b) => {
    if ((a.state === 'running') !== (b.state === 'running')) return a.state === 'running' ? -1 : 1
    return b.startedAt - a.startedAt
  })
}

const statusText = ({ word, time }: RowStatus): string => (time ? `${word} · ${time}` : word)

/**
 * A subagent row's right column (canvas 10a): `running · 2m`, `done · 14s` —
 * the words the 10f sheet and the transcript chip use, without their inks.
 */
export function subagentStatus(agent: Subagent, now: number): string {
  return statusText(subagentRowStatus(agent, now))
}

/**
 * A task row's right column (canvas 10a): `running · 3h 04m`, else how it
 * ended and when. Neutral words only; the task screen (10g) carries the colour.
 */
export function taskStatus(task: BackgroundTask, now: number): string {
  return statusText(taskRowStatus(task, now))
}

/** 9p's glyph per state: the shape carries the meaning; motion only where 9p draws it. */
export const GLYPH: Record<SessionStateKey, StateDot> = {
  needs_input: { shape: 'solid', motion: 'breathe' },
  waiting: { shape: 'hollow', motion: 'pulse' },
  working: { shape: 'solid', motion: 'pulse' },
  interrupted: { shape: 'solid', motion: 'steady' },
  done: { shape: 'hollow', motion: 'steady' },
  idle: { shape: 'solid', motion: 'steady' },
  ended: { shape: 'hollow', motion: 'steady' },
}

/** Offline, a glyph keeps its shape and colour and loses its motion (spec § 5). */
export function glyphFor(key: SessionStateKey, offline: boolean): StateDot {
  const dot = GLYPH[key]
  return offline ? { ...dot, motion: 'steady' } : dot
}

export const STATE_WORD: Record<SessionStateKey, string> = {
  needs_input: 'NEEDS INPUT', waiting: 'WAITING', interrupted: 'INTERRUPTED', done: 'DONE',
  working: 'WORKING', idle: 'IDLE', ended: 'ENDED',
}

/** 9b's header state: live, the word; offline, what it was and when (spec § 5). */
export function stateLine(key: SessionStateKey, offline: boolean, asOf: number | null, now: number): string {
  if (!offline) return STATE_WORD[key]
  return asOf === null ? `WAS ${STATE_WORD[key]}` : `WAS ${STATE_WORD[key]} · ${asOfLabel(asOf, now)}`
}
