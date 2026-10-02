import type { StateDot } from '../lib/stateStyle'
import { sessionStateKey, type ApiSession, type PendingDecision, type SessionStateKey, type Tag } from '../lib/types'
import { asOfLabel } from './format'

export type GroupKey = 'input' | 'working' | 'idle' | 'ended'

/** 9a's order (spec § 5): what asks for you first, what is over last. */
export const GROUP_ORDER: readonly GroupKey[] = ['input', 'working', 'idle', 'ended']

export const GROUP_LABEL: Record<GroupKey, string> = {
  input: 'NEEDS INPUT', working: 'WORKING', idle: 'IDLE', ended: 'ENDED',
}

type StateFields = Pick<ApiSession, 'status' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents' | 'backgroundTasks'>

/**
 * The state word decides the group. WAITING is work (its moons run); DONE
 * and INTERRUPTED ask nobody anything, so they sit with IDLE, wearing their
 * own word on the row.
 */
export function groupOf(session: StateFields): GroupKey {
  const key = sessionStateKey(session)
  if (key === 'needs_input') return 'input'
  if (key === 'working' || key === 'waiting') return 'working'
  if (key === 'ended') return 'ended'
  return 'idle'
}

export interface SessionGroup {
  key: GroupKey
  sessions: ApiSession[]
}

/** 9a's groups in order, the empty ones left out, each newest first; `tagId` filters locally. */
export function groupSessions(sessions: readonly ApiSession[], tagId: number | null): SessionGroup[] {
  const buckets = new Map<GroupKey, ApiSession[]>(GROUP_ORDER.map((key) => [key, []]))
  for (const session of sessions) {
    if (tagId !== null && !session.tagIds.includes(tagId)) continue
    buckets.get(groupOf(session))!.push(session)
  }
  return GROUP_ORDER.map((key) => ({
    key,
    sessions: buckets.get(key)!.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
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
