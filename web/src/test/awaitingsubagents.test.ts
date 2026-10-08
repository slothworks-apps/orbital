import { describe, it, expect } from 'vitest'
import { asksForHuman, awaitedWork, awaitingSubagentCount, parkedLabel, taskPhrase, waitingLabel } from '../lib/types'
import type { ApiSession, BackgroundTask, Subagent } from '../lib/types'

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
    // Regression guard: this filter is independent of the one in
    // `sceneModel.ts` that takes finished moons off the map, and must
    // survive any change to that one. It answers "is the parent still
    // waiting", which an ended agent does not affect; removing
    // it would strand a session reading WORKING forever.
    expect(
      awaitingSubagentCount(session({ subagents: [agent('a', 'ended'), agent('b')] }))
    ).toBe(1)
  })
})

const task = (kind: BackgroundTask['kind'], state: BackgroundTask['state'] = 'running'): BackgroundTask => ({
  id: `${kind}-${Math.random()}`,
  kind,
  label: kind,
  state,
  startedAt: 0,
  hasOutput: false,
})

describe('awaitedWork', () => {
  it('counts running agents and running tasks, ended ones left out', () => {
    const work = awaitedWork({
      ...session({ subagents: [agent('a'), agent('b', 'ended')] }),
      backgroundTasks: [task('shell'), task('workflow', 'ended'), task('mcp')],
    })
    expect(work).toEqual({ agents: 1, tasks: ['shell', 'mcp'] })
  })

  it('leaves out a kept shell, and counts one with no intent as waited on', () => {
    // Spec 2026-10-08-kept-shells-design § 5.
    const work = awaitedWork({
      ...session({ subagents: [] }),
      backgroundTasks: [
        { ...task('shell'), intent: 'keep' },
        { ...task('shell'), intent: 'wait' },
        task('shell'),
      ],
    })
    expect(work).toEqual({ agents: 0, tasks: ['shell', 'shell'] })
  })

  it('is empty while the session is doing something of its own', () => {
    const work = awaitedWork({ ...session({ awaitingSubagents: false }), backgroundTasks: [task('shell')] })
    expect(work).toEqual({ agents: 0, tasks: [] })
  })
})

describe('waitingLabel (26d)', () => {
  it('drops a count of one and shows it from two, agents included', () => {
    expect(waitingLabel({ agents: 1, tasks: [] })).toBe('WAITING FOR AGENT')
    expect(waitingLabel({ agents: 2, tasks: [] })).toBe('WAITING FOR 2 AGENTS')
    expect(waitingLabel({ agents: 0, tasks: ['shell'] })).toBe('WAITING FOR SHELL')
    expect(waitingLabel({ agents: 0, tasks: ['shell', 'shell'] })).toBe('WAITING FOR 2 SHELLS')
  })

  it('puts agents first, joins with +, and names mixed kinds TASKS', () => {
    expect(waitingLabel({ agents: 1, tasks: ['shell', 'shell'] })).toBe('WAITING FOR AGENT + 2 SHELLS')
    expect(waitingLabel({ agents: 0, tasks: ['shell', 'workflow'] })).toBe('WAITING FOR 2 TASKS')
    expect(waitingLabel({ agents: 2, tasks: ['shell', 'monitor'] })).toBe('WAITING FOR 2 AGENTS + 2 TASKS')
    expect(waitingLabel({ agents: 2, tasks: ['mcp', 'mcp'] })).toBe('WAITING FOR 2 AGENTS + 2 MCP TASKS')
  })
})

describe('taskPhrase', () => {
  it('always counts in the chips form', () => {
    expect(taskPhrase(['monitor'], false)).toBe('1 monitor')
    expect(taskPhrase(['mcp'], true)).toBe('MCP task')
    expect(taskPhrase([], false)).toBe('')
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
