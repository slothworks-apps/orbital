import { describe, expect, it } from 'vitest'
import { PROGRESS_TOOL, type ProgressItem } from '@orbital/shared/progress'
import { foldProgress, progressSummary, withProgressRows } from '../lib/progressList'
import type { ChatMessage } from '../lib/types'

const T0 = Date.parse('2026-11-09T14:00:00Z')
const at = (min: number) => T0 + min * 60_000
const iso = (min: number) => new Date(at(min)).toISOString()

let seq = 0
/** A call of the tool and its answer, `error` for a refused one, `answered: false` for one still waiting. */
function call(min: number, input: object, opts: { error?: boolean; answered?: boolean } = {}): ChatMessage[] {
  const n = ++seq
  const use: ChatMessage = { id: `use-${n}`, role: 'tool_use', toolName: PROGRESS_TOOL, toolUseId: `t${n}`, toolInput: input, timestamp: iso(min) }
  if (opts.answered === false) return [use]
  return [use, { id: `res-${n}`, role: 'tool_result', toolUseId: `t${n}`, isError: opts.error, timestamp: iso(min) }]
}
const said = (id: string, min: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', text: id, timestamp: iso(min), ...extra })
const item = (title: string, state: ProgressItem['state'], reason?: string): ProgressItem => ({ title, state, ...(reason ? { reason } : {}) })

describe('foldProgress', () => {
  it('folds the accepted calls and leaves a refused one and an unanswered one out of the list', () => {
    const messages = [
      ...call(2, { items: [item('Read', 'in_progress'), item('Write', 'pending')] }),
      ...call(5, { items: [item('Read', 'done'), item('Write', 'in_progress'), item('Ship', 'pending')] }, { error: true }),
      ...call(6, { items: [item('Read', 'done'), item('Write', 'in_progress')] }),
      ...call(7, { items: [item('Read', 'done'), item('Write', 'done')] }, { answered: false }),
    ]
    const fold = foldProgress(messages)
    expect(fold.list?.items.map((i) => `${i.title}:${i.state}`)).toEqual(['Read:done', 'Write:in_progress'])
    expect(fold.list?.writtenAt).toBe(at(2))
    expect(fold.list?.changedAt).toBeNull()
    // The tick is hidden, the waiting call too; the refused one is neither a row nor hidden.
    expect([...fold.calls.keys()]).toEqual(['use-1', 'use-3'])
    expect([...fold.hidden]).toEqual(['use-3', 'use-4'])
  })

  it('dates what a change added and dropped, and when every counted item got done', () => {
    const fold = foldProgress([
      ...call(2, { items: [item('A', 'pending'), item('B', 'pending')] }),
      ...call(22, { items: [item('A', 'done'), item('B', 'dropped', 'Not needed.'), item('C', 'pending')], reason: 'Found C.' }),
      ...call(40, { items: [item('A', 'done'), item('B', 'dropped'), item('C', 'done')] }),
      ...call(50, { items: [item('A', 'done'), item('B', 'dropped'), item('C', 'done')] }),
    ])
    const list = fold.list!
    expect(list.changedAt).toBe(at(22))
    expect(list.finishedAt).toBe(at(40))
    expect(list.items.find((i) => i.title === 'B')).toMatchObject({ droppedAt: at(22), reason: 'Not needed.' })
    expect(list.items.find((i) => i.title === 'C')?.addedAt).toBe(at(22))
    expect(list.items.find((i) => i.title === 'A')?.addedAt).toBeUndefined()
  })

  it('starts the times over with a new list', () => {
    const fold = foldProgress([
      ...call(2, { items: [item('A', 'done')] }),
      ...call(9, { items: [item('X', 'pending'), item('Y', 'pending')], new_list: true, reason: 'Window size next.' }),
    ])
    expect(fold.list).toMatchObject({ writtenAt: at(9), changedAt: null, finishedAt: null })
    expect(fold.calls.get('use-' + seq)?.change.kind).toBe('new_list')
  })
})

describe('withProgressRows', () => {
  it('turns a written list and a change into rows, and drops ticks and their answers', () => {
    const messages = [
      said('a', 1),
      ...call(2, { items: [item('A', 'in_progress'), item('B', 'pending')] }),
      ...call(3, { items: [item('A', 'done'), item('B', 'in_progress')] }),
      ...call(4, { items: [item('A', 'done'), item('B', 'dropped', 'No.')], reason: 'No.' }),
    ]
    const rows = withProgressRows(messages, foldProgress(messages), null)
    expect(rows.map((m) => (m.role === 'progress' ? `progress:${m.progressRow?.kind}` : m.role))).toEqual([
      'assistant',
      'progress:written',
      'progress:changed',
    ])
  })

  it('keeps a refused call as its tool row', () => {
    const messages = [...call(2, { items: [] }, { error: true })]
    expect(withProgressRows(messages, foldProgress(messages), null).map((m) => m.role)).toEqual(['tool_use', 'tool_result'])
  })

  it('lays the freeze after the harness’s first message, or where its time falls', () => {
    const messages = [
      ...call(2, { items: [item('A', 'in_progress')] }),
      said('kickoff', 40, { role: 'harness', text: 'started · Ship' }),
      said('b', 41),
    ]
    const fold = foldProgress(messages)
    expect(withProgressRows(messages, fold, at(40)).map((m) => m.id)).toEqual(['use-' + seq, 'kickoff', 'progress:frozen', 'b'])
    const withoutKickoff = messages.filter((m) => m.id !== 'kickoff')
    expect(withProgressRows(withoutKickoff, fold, at(40)).map((m) => m.id)).toEqual(['use-' + seq, 'progress:frozen', 'b'])
  })
})

describe('progressSummary', () => {
  const items = [item('A', 'done'), item('B', 'dropped'), item('C', 'pending')]
  it('says what the figure leaves out', () => {
    expect(progressSummary(items, false)).toBe('1 dropped · 1 to go')
    expect(progressSummary(items, true)).toBe('1 dropped · 1 left as they were')
    expect(progressSummary([item('A', 'done'), item('B', 'dropped')], false)).toBe('all done · 1 dropped')
    expect(progressSummary([item('A', 'pending')], false)).toBe('1 to go')
  })
})
