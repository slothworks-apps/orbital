import { describe, expect, it } from 'vitest'
import { depsOf, descendantsOf, diffSteps, gutterLayout, isLinear, withChanges } from '../lib/harnessGraph'
import type { HarnessStep } from '../lib/types'

const step = (id: string, dependsOn?: string[]): HarnessStep => ({ id, title: id, instructions: '', mode: 'auto', doneWhen: '', dependsOn })

// load → build → story → parity ─┐
//      └→ calls ─┴→ migrate ─────┴→ pr
const graph = [
  step('load'), step('build'), step('calls', ['load']), step('story', ['build']), step('parity', ['story']),
  step('migrate', ['build', 'calls']), step('pr', ['parity', 'migrate']),
]

describe('the harness graph', () => {
  it('a step without dependsOn needs the one before; [] needs nothing', () => {
    expect(depsOf(graph, 0)).toEqual([])
    expect(depsOf(graph, 1)).toEqual(['load'])
    expect(depsOf([step('a'), step('b', [])], 1)).toEqual([])
    expect(isLinear([step('a'), step('b'), step('c')])).toBe(true)
    expect(isLinear(graph)).toBe(false)
  })

  it('finds what needs a step, through other steps too', () => {
    expect(descendantsOf(graph, 1)).toEqual([3, 4, 5, 6])
    expect(descendantsOf(graph, 2)).toEqual([5, 6])
    expect(descendantsOf(graph, 6)).toEqual([])
  })

  it('a plain list is one lane, a line between each pair', () => {
    const { rows, lanes } = gutterLayout([step('a'), step('b'), step('c')])
    expect(lanes).toBe(1)
    expect(rows).toEqual([
      { lane: 0, through: [], top: false, merges: [], bottom: true, forks: [], below: [0] },
      { lane: 0, through: [], top: true, merges: [], bottom: true, forks: [], below: [0] },
      { lane: 0, through: [], top: true, merges: [], bottom: false, forks: [], below: [] },
    ])
  })

  it('forks into a second lane, passes rows by, and joins where a step needs both', () => {
    const { rows, lanes } = gutterLayout(graph)
    expect(lanes).toBe(3)
    // load forks: build below it, calls in lane 1.
    expect(rows[0]).toMatchObject({ lane: 0, bottom: true, forks: [1] })
    // build continues to story and forks to migrate.
    expect(rows[1]).toMatchObject({ lane: 0, top: true, bottom: true, forks: [2], through: [1], below: [0, 1, 2] })
    expect(rows[2]).toMatchObject({ lane: 1, top: true, through: [0, 2] })
    // migrate joins build's line and calls' line.
    expect(rows[5]).toMatchObject({ lane: 1, top: true, merges: [2] })
    expect(rows[6]).toMatchObject({ lane: 0, top: true, merges: [1], bottom: false })
  })

  it('several roots each start their own lane', () => {
    const { rows } = gutterLayout([step('a', []), step('b', []), step('c', ['a', 'b'])])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0])
    expect(rows[0]).toMatchObject({ top: false, bottom: true })
    expect(rows[1]).toMatchObject({ top: false, bottom: true, through: [0] })
    expect(rows[2]).toMatchObject({ top: true, merges: [1] })
  })
})

describe('editing steps', () => {
  it('turns an edited list into the change the edit route takes', () => {
    const before = [step('a'), step('b'), step('c')]
    const after = [step('a'), { ...step('c'), title: 'C' }, step('d', ['a'])]
    expect(diffSteps(before, after)).toEqual({ add: [step('d', ['a'])], update: [{ ...step('c'), title: 'C' }], remove: ['b'] })
    expect(diffSteps(before, before.map((s) => ({ ...s, verify: '' })))).toEqual({})
    expect(withChanges(before, { remove: ['b'], add: [step('d')], update: [{ ...step('a'), title: 'A' }] }).map((s) => s.title)).toEqual(['A', 'c', 'd'])
  })
})
