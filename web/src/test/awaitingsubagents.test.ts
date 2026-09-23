import { describe, it, expect } from 'vitest'
import { asksForHuman, awaitingSubagentCount, awaitingSubagentLabel, parkedLabel } from '../lib/types'
import type { ApiSession, Subagent } from '../lib/types'

const agent = (id: string, state: Subagent['state'] = 'working'): Subagent => ({
  id,
  name: id,
  state,
  startedAt: 0,
})

type Shape = Pick<ApiSession, 'status' | 'awaitingSubagents' | 'subagents'>

const session = (over: Partial<Shape> = {}): Shape => ({
  status: 'working',
  awaitingSubagents: true,
  subagents: [agent('a')],
  ...over,
})

describe('awaitingSubagentCount', () => {
  it('counts the agents a working session is parked on', () => {
    expect(awaitingSubagentCount(session({ subagents: [agent('a'), agent('b')] }))).toBe(2)
  })

  it('is zero while the session is doing something of its own', () => {
    // The server only sets the flag once the main loop's turn is over, but a
    // status event can land ahead of the snapshot that clears it — and a
    // planet that is genuinely thinking must never read WAITING FOR AGENT.
    expect(awaitingSubagentCount(session({ awaitingSubagents: false }))).toBe(0)
  })

  it('is zero for every status but working', () => {
    for (const status of ['needs_input', 'idle', 'ended'] as const) {
      expect(awaitingSubagentCount(session({ status }))).toBe(0)
    }
  })

  it('is zero when the server never sent the field at all (older snapshot)', () => {
    expect(awaitingSubagentCount(session({ awaitingSubagents: undefined }))).toBe(0)
  })

  it('ignores agents that have already reported back', () => {
    // Regression guard (task 9): `sceneModel.ts` stopped filtering ended
    // agents out of `moons` — they now stay on the map until dismissed
    // (spec § 4) — but THIS filter must not follow suit. It answers "is the
    // parent still waiting", which an ended agent does not affect; removing
    // it would strand a session reading WORKING forever.
    expect(
      awaitingSubagentCount(session({ subagents: [agent('a', 'ended'), agent('b')] }))
    ).toBe(1)
  })
})

describe('awaitingSubagentLabel', () => {
  it('agrees with itself about grammar', () => {
    expect(awaitingSubagentLabel(1)).toBe('WAITING FOR AGENT')
    expect(awaitingSubagentLabel(3)).toBe('WAITING FOR AGENTS')
  })
})

describe('parkedLabel', () => {
  it('says NEEDS INPUT only when something is actually parked on the human', () => {
    const decision = { id: 'tu-1', kind: 'question' } as never
    expect(parkedLabel({ pendingDecision: decision })).toBe('NEEDS INPUT')
  })

  it('says DONE for a turn that merely finished', () => {
    // The CLI parks on stdin either way, so the status is `needs_input` for
    // both — this is the only thing that tells them apart.
    expect(parkedLabel({ pendingDecision: null })).toBe('DONE')
    expect(parkedLabel({ pendingDecision: undefined })).toBe('DONE')
  })

  it('agrees with asksForHuman, which gates the ring and the pulsing dot', () => {
    // A DONE pill over a rippling planet (or the reverse) is the map
    // contradicting itself.
    const decision = { id: 'tu-1', kind: 'permission' } as never
    for (const pendingDecision of [decision, null, undefined]) {
      expect(asksForHuman({ pendingDecision })).toBe(parkedLabel({ pendingDecision }) === 'NEEDS INPUT')
    }
  })
})
