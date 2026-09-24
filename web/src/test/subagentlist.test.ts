import { describe, it, expect } from 'vitest'
import type { Subagent } from '../lib/types'
import { chipSegments, isOpenable, listGroups, rowElapsedMs, rowStateWord } from '../lib/subagentList'

// ---------------------------------------------------------------------------
// The subagent list's pure model (subagent list spec §§ 1, 2): the chip's
// counts, the dropdown's groups and order, and what a row reads.
// ---------------------------------------------------------------------------

function agent(id: string, overrides: Partial<Subagent> = {}): Subagent {
  return { id, name: id, state: 'working', toolUseId: `tool-${id}`, startedAt: 0, ...overrides }
}

function ended(id: string, overrides: Partial<Subagent> = {}): Subagent {
  return agent(id, { state: 'ended', status: 'completed', ...overrides })
}

const ids = (rows: readonly Subagent[]) => rows.map((r) => r.id)

describe('chipSegments', () => {
  it('is empty for no subagents — no chip at all', () => {
    expect(chipSegments([])).toEqual([])
  })

  it('counts running, done and failed, in that order', () => {
    const list = [
      ended('f', { status: 'failed' }),
      agent('r1'),
      ended('d1'),
      agent('r2', { state: 'needs_input' }),
      ended('d2'),
    ]
    expect(chipSegments(list)).toEqual([
      { kind: 'running', count: 2 },
      { kind: 'done', count: 2 },
      { kind: 'failed', count: 1 },
    ])
  })

  it('counts every state that is not ended as running', () => {
    const list = (['materializing', 'working', 'idle', 'needs_input'] as const).map((state) =>
      agent(state, { state })
    )
    expect(chipSegments(list)).toEqual([{ kind: 'running', count: 4 }])
  })

  it('counts stopped and status-less ended agents as done, not as a segment of their own', () => {
    const list = [ended('s', { status: 'stopped' }), ended('n', { status: undefined }), ended('c')]
    expect(chipSegments(list)).toEqual([{ kind: 'done', count: 3 }])
  })

  it('drops zero segments', () => {
    expect(chipSegments([agent('r')])).toEqual([{ kind: 'running', count: 1 }])
    expect(chipSegments([agent('r'), ended('f', { status: 'failed' })])).toEqual([
      { kind: 'running', count: 1 },
      { kind: 'failed', count: 1 },
    ])
  })
})

describe('listGroups', () => {
  it('is empty for no subagents', () => {
    expect(listGroups([])).toEqual([])
  })

  it('puts RUNNING first, newest start first, then DONE, newest end first', () => {
    const list = [
      ended('d-old', { startedAt: 1, endedAt: 100 }),
      agent('r-old', { startedAt: 10 }),
      ended('d-new', { startedAt: 2, endedAt: 300 }),
      agent('r-new', { startedAt: 50 }),
      ended('f-mid', { status: 'failed', startedAt: 3, endedAt: 200 }),
    ]
    const groups = listGroups(list)
    expect(groups.map((g) => [g.key, g.heading])).toEqual([
      ['running', 'RUNNING · 2'],
      ['done', 'DONE · 3'],
    ])
    expect(ids(groups[0].rows)).toEqual(['r-new', 'r-old'])
    // DONE holds every finished state, failed included.
    expect(ids(groups[1].rows)).toEqual(['d-new', 'f-mid', 'd-old'])
  })

  it('omits a group with no rows', () => {
    expect(listGroups([agent('r')]).map((g) => g.key)).toEqual(['running'])
    expect(listGroups([ended('d', { endedAt: 5 })]).map((g) => g.key)).toEqual(['done'])
  })

  it('sorts ended agents without endedAt last, by startedAt newest first', () => {
    const list = [
      ended('no-end-old', { startedAt: 1, endedAt: undefined }),
      ended('stamped', { startedAt: 0, endedAt: 10 }),
      ended('no-end-new', { startedAt: 5, endedAt: undefined }),
    ]
    expect(ids(listGroups(list)[0].rows)).toEqual(['stamped', 'no-end-new', 'no-end-old'])
  })

  it('keeps ties in input order, both groups', () => {
    const list = [
      agent('r-a', { startedAt: 7 }),
      ended('d-a', { endedAt: 9 }),
      agent('r-b', { startedAt: 7 }),
      ended('d-b', { endedAt: 9 }),
    ]
    const [running, done] = listGroups(list)
    expect(ids(running.rows)).toEqual(['r-a', 'r-b'])
    expect(ids(done.rows)).toEqual(['d-a', 'd-b'])
  })

  it('does not reorder the list it was given', () => {
    const list = [agent('old', { startedAt: 1 }), agent('new', { startedAt: 2 })]
    listGroups(list)
    expect(ids(list)).toEqual(['old', 'new'])
  })
})

describe('rowStateWord', () => {
  it('is empty for a running agent', () => {
    expect(rowStateWord(agent('r'))).toBe('')
    expect(rowStateWord(agent('r', { state: 'needs_input', status: 'failed' }))).toBe('')
  })

  it('names how an ended agent finished', () => {
    expect(rowStateWord(ended('c', { status: 'completed' }))).toBe('done')
    expect(rowStateWord(ended('n', { status: undefined }))).toBe('done')
    expect(rowStateWord(ended('f', { status: 'failed' }))).toBe('failed')
    expect(rowStateWord(ended('s', { status: 'stopped' }))).toBe('stopped')
  })
})

describe('rowElapsedMs', () => {
  it('measures a running agent against now', () => {
    expect(rowElapsedMs(agent('r', { startedAt: 1000 }), 4000)).toBe(3000)
  })

  it('never goes negative when the clock reads earlier than the start', () => {
    expect(rowElapsedMs(agent('r', { startedAt: 5000 }), 4000)).toBe(0)
  })

  it('freezes an ended agent at endedAt, whatever now reads', () => {
    const done = ended('d', { startedAt: 1000, endedAt: 8000 })
    expect(rowElapsedMs(done, 60_000)).toBe(7000)
    expect(rowElapsedMs(done, 90_000)).toBe(7000)
  })

  it('is unknown for an ended agent with no endedAt — never a fabricated number', () => {
    expect(rowElapsedMs(ended('d', { endedAt: undefined }), 60_000)).toBeUndefined()
  })

  it('ignores a stale endedAt on a running agent', () => {
    expect(rowElapsedMs(agent('r', { startedAt: 1000, endedAt: 2000 }), 4000)).toBe(3000)
  })
})

describe('isOpenable', () => {
  it('is true only when the agent carries a toolUseId', () => {
    expect(isOpenable(agent('a'))).toBe(true)
    expect(isOpenable(ended('e'))).toBe(true)
    expect(isOpenable(agent('b', { toolUseId: undefined }))).toBe(false)
    expect(isOpenable(agent('c', { toolUseId: '' }))).toBe(false)
  })
})
