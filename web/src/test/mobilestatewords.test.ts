import { describe, expect, it } from 'vitest'
import type { LimitWait, PendingDecision } from '../lib/types'
import { asOfLabel } from '../mobile/format'
import { headerState, type HeaderSession } from '../mobile/stateWords'

// Local time, so the clock words read the same whatever the machine's zone.
const NOW = new Date(2026, 9, 5, 13, 41).getTime()
const AS_OF = new Date(2026, 9, 5, 13, 30).getTime()
const RESET = new Date(2026, 9, 5, 14, 5).toISOString()

function session(patch: Partial<HeaderSession> = {}): HeaderSession {
  return { status: 'idle', subagents: [], ...patch }
}

const wait = (patch: Partial<LimitWait> = {}): LimitWait => ({
  resetsAt: RESET, windowKind: 'five_hour', windowLabel: '5-hour window',
  cancelled: false, willContinue: true, queued: [], ...patch,
})

const question: PendingDecision = {
  id: 'q', kind: 'question', createdAt: 1,
  input: { questions: [{ question: 'Which?', header: 'which', options: [], multiSelect: false }] },
}

const live = (s: HeaderSession, reopenedStep: number | null = null) =>
  headerState({ session: s, offline: false, asOf: AS_OF, now: NOW, reopenedStep })
const asleep = (s: HeaderSession, asOf: number | null = AS_OF) =>
  headerState({ session: s, offline: true, asOf, now: NOW, reopenedStep: null })

describe('headerState', () => {
  it("keeps 9b's words, with the age live and the as-of asleep", () => {
    expect(live(session({ status: 'working' }))).toEqual({ kind: 'plain', word: 'WORKING', age: true })
    expect(live(session())).toEqual({ kind: 'plain', word: 'IDLE', age: true })
    expect(live(session({ status: 'ended' }))).toEqual({ kind: 'plain', word: 'ENDED', age: true })
    expect(asleep(session({ status: 'working' }))).toEqual({
      kind: 'plain', word: `WAS WORKING · ${asOfLabel(AS_OF, NOW)}`, age: false,
    })
  })

  it('reads NEEDS YOUR OK at a waiting gate, without an age, and still so asleep', () => {
    const gate = session({ status: 'needs_input', harnessGate: 'waiting' })
    expect(live(gate)).toEqual({ kind: 'gate', word: 'NEEDS YOUR OK', age: false })
    expect(asleep(gate)).toEqual({ kind: 'gate', word: `NEEDS YOUR OK · ${asOfLabel(AS_OF, NOW)}`, age: false })
    expect(asleep(gate, null).word).toBe('NEEDS YOUR OK')
  })

  it('lets a parked question win over a waiting gate', () => {
    const both = session({ status: 'needs_input', harnessGate: 'waiting', pendingDecision: question })
    expect(live(both)).toEqual({ kind: 'plain', word: 'NEEDS INPUT', age: true })
  })

  it('reads REVIEWER READING while the reviewer has the gate', () => {
    const reviewing = session({ harnessGate: 'reviewing' })
    expect(live(reviewing)).toEqual({ kind: 'reviewer', word: 'REVIEWER READING', age: false })
    expect(asleep(reviewing).word).toBe(`WAS REVIEWER READING · ${asOfLabel(AS_OF, NOW)}`)
    // Work under way is work, whoever reads the gate.
    expect(live(session({ status: 'working', harnessGate: 'reviewing' })).kind).toBe('plain')
  })

  it('names the reset while it waits for a limit, and the limit once nothing will continue', () => {
    expect(live(session({ limitWait: wait() }))).toEqual({ kind: 'limit', word: 'WAITING FOR LIMIT · 14:05', age: false })
    expect(live(session({ limitWait: wait({ cancelled: true, willContinue: false }) })).word).toBe('IDLE · LIMIT UNTIL 14:05')
    // A queued message goes out at the reset even with the wait cancelled.
    expect(live(session({ limitWait: wait({ cancelled: true, willContinue: false, queued: ['hi'] }) })).word).toBe(
      'WAITING FOR LIMIT · 14:05',
    )
  })

  it('says what the limit wait was while the Mac sleeps', () => {
    expect(asleep(session({ limitWait: wait() }))).toEqual({
      kind: 'limit', word: `WAS WAITING FOR LIMIT · ${asOfLabel(AS_OF, NOW)}`, age: false,
    })
    expect(asleep(session({ limitWait: wait({ cancelled: true, willContinue: false }) })).word).toBe(
      `WAS IDLE · ${asOfLabel(AS_OF, NOW)}`,
    )
  })

  it("hands a reopened step to the user until it works again, and only live", () => {
    expect(live(session({ status: 'needs_input' }), 4)).toEqual({ kind: 'reopened', word: 'REOPENED · YOUR TURN', age: false })
    expect(live(session({ status: 'working' }), 4).word).toBe('WORKING')
    expect(headerState({ session: session(), offline: true, asOf: AS_OF, now: NOW, reopenedStep: 4 }).kind).toBe('plain')
  })
})
