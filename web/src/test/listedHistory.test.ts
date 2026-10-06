import { describe, expect, it } from 'vitest'
import {
  endedOutOfList, historyEndedOutOfList, mergeListed, taskRuns, withDetailHistory, withHeldHistory,
} from '../lib/listedHistory'
import type { ApiSession, BackgroundTask, Subagent } from '../lib/types'

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: over.id ?? 't',
  kind: 'shell',
  label: 'Run tests',
  state: 'ended',
  startedAt: 0,
  hasOutput: true,
  ...over,
})

const agent = (id: string, state: Subagent['state'], startedAt = 0): Subagent => ({ id, name: id, state, startedAt })

const session = (patch: Partial<ApiSession> = {}): ApiSession => ({
  id: 's', cwd: '/w/s', title: 's', firstAt: 1, lastAt: 1, messageCount: 1, source: 'web', permissionMode: null,
  model: null, resolvedModel: null, tagIds: [], status: 'working', subagents: [], ...patch,
})

describe('mergeListed', () => {
  it('keeps ended items the listed shape left out, in start order', () => {
    const held = [task({ id: 'a', startedAt: 1 }), task({ id: 'b', startedAt: 2 })]
    const next = [task({ id: 'b', startedAt: 2, label: 'fresh' }), task({ id: 'c', startedAt: 3, state: 'running' })]
    const merged = mergeListed(held, next, taskRuns)
    expect(merged?.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(merged?.[1].label).toBe('fresh')
  })

  it('drops a held running item the next list no longer has', () => {
    const next = [task({ id: 'b' })]
    expect(mergeListed([task({ id: 'a', state: 'running' })], next, taskRuns)).toBe(next)
  })

  it('passes next through when nothing is held', () => {
    const next = [task({ id: 'a' })]
    expect(mergeListed(undefined, next, taskRuns)).toBe(next)
  })
})

describe('endedOutOfList', () => {
  it('is true when a held running item is missing from the listed ones', () => {
    expect(endedOutOfList([task({ id: 'a', state: 'running' })], [], taskRuns)).toBe(true)
  })

  it('is false when every held running item is still listed, or only ended ones are missing', () => {
    expect(endedOutOfList([task({ id: 'a', state: 'running' }), task({ id: 'b' })], [task({ id: 'a', state: 'running' })], taskRuns)).toBe(false)
  })
})

describe('a session across listed upserts', () => {
  it('keeps the ended subagents and tasks it held, and counts any working state but ended as running', () => {
    const held = session({
      subagents: [agent('done', 'ended', 1), agent('busy', 'needs_input', 2)],
      backgroundTasks: [task({ id: 'old', startedAt: 1 })],
    })
    const next = session({ subagents: [agent('busy', 'needs_input', 2)], backgroundTasks: [] })
    const merged = withHeldHistory(held, next)
    expect(merged.subagents.map((a) => a.id)).toEqual(['done', 'busy'])
    expect(merged.backgroundTasks?.map((t) => t.id)).toEqual(['old'])
    expect(historyEndedOutOfList(held, next)).toBe(false)
  })

  it('asks for the history again when a running subagent drops out', () => {
    const held = session({ subagents: [agent('busy', 'working')] })
    expect(historyEndedOutOfList(held, session())).toBe(true)
    expect(withHeldHistory(held, session()).subagents).toEqual([])
  })
})

describe('withDetailHistory', () => {
  it('takes what ended from the detail and keeps what the list still runs', () => {
    const current = session({
      subagents: [agent('stale', 'ended', 1), agent('new', 'working', 3)],
      backgroundTasks: [task({ id: 'run', state: 'running', startedAt: 2 })],
    })
    const detail = session({
      subagents: [agent('finished', 'ended', 2)],
      backgroundTasks: [task({ id: 'gone', startedAt: 1 }), task({ id: 'run', state: 'running', startedAt: 2 })],
    })
    const merged = withDetailHistory(current, detail)
    // `stale` is known only to the client: a Mac restart forgot it, and its buffer with it.
    expect(merged.subagents.map((a) => a.id)).toEqual(['finished', 'new'])
    expect(merged.backgroundTasks?.map((t) => t.id)).toEqual(['gone', 'run'])
  })
})
