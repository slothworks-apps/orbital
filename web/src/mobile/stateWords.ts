import { continuesAtReset, formatResetAt } from '../lib/limits'
import { gateWaits, sessionStateKey, type ApiSession } from '../lib/types'
import { asOfLabel } from './format'
import { STATE_WORD, stateLine } from './sessionList'

/**
 * The session header's state (spec 2026-10-05-mobile-next-design § 1, § 5;
 * canvas 10b, 10c, 10k on top of 9b): the word on row 2, the mark in front of
 * it, and whether the last activity's age follows it. Pure; `StateLine` draws
 * it.
 */

/**
 * Which state the header is in, and so which mark and ink it wears:
 * `plain` is 9b's (the 9p glyph in the state's colour), `gate` the still
 * diamond of NEEDS YOUR OK, the rest a still hollow dot in a neutral ink.
 */
export type HeaderStateKind = 'plain' | 'gate' | 'reviewer' | 'limit' | 'reopened'

export interface HeaderState {
  kind: HeaderStateKind
  word: string
  /** The live "· 3m" after the word; a gate, a limit wait and every asleep form carry none. */
  age: boolean
}

export type HeaderSession = Pick<
  ApiSession,
  | 'status' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents' | 'backgroundTasks'
  | 'harnessGate' | 'limitWait'
>

export interface HeaderStateInput {
  session: HeaderSession
  offline: boolean
  asOf: number | null
  now: number
  /** The step a Reopen on this session left to the user (`composerIntent`), or null. */
  reopenedStep: number | null
}

/** "WORD · as of 14:32" asleep, the bare word when the phone never had live data. */
function asleep(word: string, asOf: number | null, now: number): string {
  return asOf === null ? word : `${word} · ${asOfLabel(asOf, now)}`
}

export function headerState({ session, offline, asOf, now, reopenedStep }: HeaderStateInput): HeaderState {
  const key = sessionStateKey(session)
  const plain: HeaderState = { kind: 'plain', word: stateLine(key, offline, asOf, now), age: !offline }

  // A tool call parked on the user is NEEDS INPUT, gate or not (`parkedLabel`).
  if (key === 'needs_input' && !session.pendingDecision && gateWaits(session)) {
    // Canvas 10c asleep: a gate still waits while the Mac sleeps, so no WAS.
    return { kind: 'gate', word: offline ? asleep('NEEDS YOUR OK', asOf, now) : 'NEEDS YOUR OK', age: false }
  }
  if (key === 'needs_input' || key === 'working' || key === 'ended') return plain

  const wait = session.limitWait
  if (wait) {
    // Canvas 10k `wState`; asleep, 10k's "WAS WAITING FOR LIMIT · as of".
    const continues = continuesAtReset(wait)
    if (offline) return { kind: 'limit', word: asleep(continues ? 'WAS WAITING FOR LIMIT' : `WAS ${STATE_WORD.idle}`, asOf, now), age: false }
    const at = formatResetAt(wait.resetsAt, now)
    return { kind: 'limit', word: continues ? `WAITING FOR LIMIT · ${at}` : `IDLE · LIMIT UNTIL ${at}`, age: false }
  }
  if (session.harnessGate === 'reviewing') {
    // Canvas 10c: the gate is the reviewer's, not the user's.
    return { kind: 'reviewer', word: offline ? asleep('WAS REVIEWER READING', asOf, now) : 'REVIEWER READING', age: false }
  }
  if (reopenedStep !== null && !offline) {
    // Canvas 10b, third phone: the step is back with the user until they write.
    return { kind: 'reopened', word: 'REOPENED · YOUR TURN', age: false }
  }
  return plain
}
