import { describe, it, expect } from 'vitest'
import type { Walkthrough, WalkthroughStep } from '../lib/types'
import { blindAlleySteps, fileCounts, foldedLine, gapBefore, midTurn, nextScreen, prevScreen, railGroups, sessionSpan, settleScreen, stillOpen, type Screen } from '../walkthrough/derive'

const step = (id: string, ordinal: number, patch: Partial<WalkthroughStep> = {}): WalkthroughStep => ({
  id, ordinal, narration: '', calls: [], folded: {}, subagent: null, fate: [], durationMs: null, ...patch,
})
const editCall = (path: string, from: string, to: string, isError = false) => ({
  call: { id: 'c', role: 'tool_use' as const, toolName: 'Edit', toolInput: { file_path: path, old_string: from, new_string: to }, toolUseId: 'c' },
  result: { id: 'r', role: 'tool_result' as const, toolUseId: 'c', text: isError ? 'old_string not found' : 'ok', ...(isError ? { isError: true } : {}) },
})
const base = (patch: Partial<Walkthrough> = {}): Walkthrough => ({
  steps: [step('a', 1), step('b', 2), step('c', 3)],
  timeline: [{ kind: 'gap', durationMs: null, folded: { Read: 2 }, subagents: [], said: 'hm' }, { kind: 'step', id: 'a' }, { kind: 'step', id: 'b' }, { kind: 'gap', durationMs: null, folded: {}, subagents: ['survey'], said: '' }, { kind: 'step', id: 'c' }],
  files: [], narration: null, narrationFailed: false, narrationPending: false, narrationFailure: null, lastMessageId: null, ...patch,
})

describe('railGroups', () => {
  it('is one untitled group without narration', () => {
    expect(railGroups(base()).map((g) => [g.title, g.steps.map((s) => s.id)])).toEqual([[null, ['a', 'b', 'c']]])
  })
  it('follows the intents when narrated', () => {
    const w = base({ narration: { staleSteps: 0, intents: [{ title: 'T', summary: '', steps: ['a', 'b'], considered: [], abandoned: false }, { title: '', summary: '', steps: ['c'], considered: [], abandoned: false }] } })
    expect(railGroups(w).map((g) => [g.title, g.steps.map((s) => s.id)])).toEqual([['T', ['a', 'b']], [null, ['c']]])
  })
})

describe('gapBefore', () => {
  it('finds the gap immediately preceding a step, and null when a step precedes it', () => {
    expect(gapBefore(base(), 'a')?.folded).toEqual({ Read: 2 })
    expect(gapBefore(base(), 'b')).toBeNull()
    expect(gapBefore(base(), 'c')?.subagents).toEqual(['survey'])
  })
})

describe('foldedLine', () => {
  it('words the common tools and counts the rest', () => {
    expect(foldedLine({ Read: 4, Bash: 2, Grep: 1, Glob: 2 })).toBe('read 4 files · ran 2 commands · 3 searches')
    expect(foldedLine({ Read: 1 })).toBe('read 1 file')
    expect(foldedLine({ WebFetch: 2 })).toBe('2 other calls')
    expect(foldedLine({})).toBe('')
  })
})

describe('fileCounts / blindAlleySteps / stillOpen', () => {
  it('sums Edit counts per path and refuses paths with nothing countable', () => {
    const w = base({ steps: [step('a', 1, { calls: [editCall('x.ts', 'p\nq', 'p\nr\ns')] }), step('b', 2, { calls: [editCall('x.ts', 'r', 'z')] })] })
    expect(fileCounts(w, 'x.ts')).toEqual({ added: 3, removed: 2 })
    expect(fileCounts(w, 'none.ts')).toBeNull()
  })
  it('a reverted step or an abandoned intent is a blind alley; a failed call is still open', () => {
    const w = base({
      steps: [step('a', 1, { fate: [{ kind: 'reverted', byStep: 'c', path: 'x' }] }), step('b', 2), step('c', 3, { calls: [editCall('cfg', 'q', 'r', true)] })],
      narration: { staleSteps: 0, intents: [{ title: '', summary: '', steps: ['a'], considered: [], abandoned: false }, { title: 'retry', summary: '', steps: ['b'], considered: [], abandoned: true }, { title: '', summary: '', steps: ['c'], considered: [], abandoned: false }] },
    })
    expect(blindAlleySteps(w).map((s) => s.id)).toEqual(['a', 'b'])
    expect(stillOpen(w).map((o) => o.step.id)).toEqual(['c'])
  })
  it('a failed call retried successfully on its path is not still open', () => {
    const retried = base({ steps: [step('a', 1, { calls: [editCall('cfg', 'q', 'r', true)] }), step('b', 2, { calls: [editCall('cfg', 'Q', 'r')] })] })
    expect(stillOpen(retried)).toEqual([])
    const elsewhere = base({ steps: [step('a', 1, { calls: [editCall('cfg', 'q', 'r', true)] }), step('b', 2, { calls: [editCall('other', 'Q', 'r')] })] })
    expect(stillOpen(elsewhere).map((o) => o.step.id)).toEqual(['a'])
  })
})

describe('screens', () => {
  const ids = ['a', 'b', 'c']
  it('walks cover → steps → close and back, clamped', () => {
    expect(nextScreen({ kind: 'cover' }, ids)).toEqual({ kind: 'step', id: 'a' })
    expect(nextScreen({ kind: 'step', id: 'a' }, ids)).toEqual({ kind: 'step', id: 'b' })
    expect(nextScreen({ kind: 'step', id: 'c' }, ids)).toEqual({ kind: 'close' })
    expect(nextScreen({ kind: 'close' }, ids)).toEqual({ kind: 'close' })
    expect(prevScreen({ kind: 'step', id: 'a' }, ids)).toEqual({ kind: 'cover' })
    expect(prevScreen({ kind: 'step', id: 'c' }, ids)).toEqual({ kind: 'step', id: 'b' })
    expect(prevScreen({ kind: 'close' }, ids)).toEqual({ kind: 'step', id: 'c' })
    expect(nextScreen({ kind: 'cover' }, [])).toEqual({ kind: 'close' })
  })
  it('keeps the step being read when a step is inserted before it', () => {
    const reading: Screen = { kind: 'step', id: 'b' }
    const grown = ['a', 'ag1', 'b', 'c']
    expect(settleScreen(reading, grown)).toEqual(reading)
    expect(nextScreen(reading, grown)).toEqual({ kind: 'step', id: 'c' })
    expect(prevScreen(reading, grown)).toEqual({ kind: 'step', id: 'ag1' })
  })
  it('clamps a vanished step to the last step, or the cover when none are left', () => {
    expect(settleScreen({ kind: 'step', id: 'gone' }, ids)).toEqual({ kind: 'step', id: 'c' })
    expect(settleScreen({ kind: 'step', id: 'gone' }, [])).toEqual({ kind: 'cover' })
    expect(settleScreen({ kind: 'close' }, [])).toEqual({ kind: 'close' })
  })
})

describe('sessionSpan', () => {
  it('names the date once on one day, twice across midnight, and nothing when an end is unknown', () => {
    const at = (d: number, h: number, m: number) => new Date(2026, 8, d, h, m).getTime()
    expect(sessionSpan(at(9, 14, 2), at(9, 16, 24))).toBe('9 SEP 14:02 → 16:24')
    expect(sessionSpan(at(9, 23, 50), at(10, 0, 5))).toBe('9 SEP 23:50 → 10 SEP 00:05')
    expect(sessionSpan(null, at(9, 16, 24))).toBeNull()
  })
})

describe('midTurn', () => {
  it('is working or parked on a decision — never needs_input alone', () => {
    expect(midTurn({ status: 'working', pendingDecision: null })).toBe(true)
    expect(midTurn({ status: 'needs_input', pendingDecision: null })).toBe(false)
    expect(midTurn({ status: 'needs_input' })).toBe(false)
    expect(midTurn({ status: 'needs_input', pendingDecision: { kind: 'permission' } as never })).toBe(true)
  })
})
