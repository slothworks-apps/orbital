import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Subagent, TaskOutputTail } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

/** One fake socket, recording subscribes and releases per topic — the `subagentstore.test.ts` shape. */
const { subscribeSpy, releaseSpy, handlers } = vi.hoisted(() => {
  const releaseSpy = vi.fn((topic: string) => topic)
  const handlers = new Map<string, (msg: unknown) => void>()
  const subscribeSpy = vi.fn((topic: string, handler: (msg: unknown) => void) => {
    handlers.set(topic, handler)
    return () => {
      handlers.delete(topic)
      releaseSpy(topic)
    }
  })
  return { subscribeSpy, releaseSpy, handlers }
})
vi.mock('../lib/socket', () => ({ getSocket: () => ({ subscribe: subscribeSpy }) }))

import { api, ApiError } from '../lib/api'
import { useOrbital } from '../store/store'
import { displayLines } from '../lib/backgroundTasks'

const SESSION = 'session-1'
const TOPIC = `task-output:${SESSION}:b1`

const lines = () => displayLines(useOrbital.getState().taskOutput!.output)
const emit = (msg: unknown) => handlers.get(TOPIC)!(msg)

beforeEach(() => {
  useOrbital.getState().closeTaskOutput()
  useOrbital.getState().closeSubagent()
  vi.clearAllMocks()
  handlers.clear()
  useOrbital.setState({
    subagentPanel: null,
    taskOutput: null,
    stoppingTasks: {},
    toast: null,
    ui: { ...useOrbital.getState().ui, selectedId: SESSION },
  })
})

describe('openTaskOutput', () => {
  it('folds bytes that arrive during the fetch in after the tail, without repeating any', async () => {
    let resolve!: (tail: TaskOutputTail) => void
    vi.mocked(api.taskOutput).mockReturnValue(new Promise((r) => (resolve = r)))

    const opened = useOrbital.getState().openTaskOutput(SESSION, 'b1')
    expect(subscribeSpy).toHaveBeenCalledWith(TOPIC, expect.any(Function))

    // Overlaps the tail by its last line, then carries on past it.
    emit({ event: 'output', offset: 4, text: 'two\nthree\n' })
    resolve({ text: 'one\ntwo\n', start: 0, end: 8 })
    await opened

    expect(lines()).toEqual(['one', 'two', 'three'])
    expect(useOrbital.getState().taskOutput?.end).toBe(14)
  })

  it('cuts an overlapping chunk in bytes, not characters', async () => {
    // `ž` is two bytes: the tail ends after it at byte 3.
    vi.mocked(api.taskOutput).mockResolvedValue({ text: 'až', start: 0, end: 3 })
    await useOrbital.getState().openTaskOutput(SESSION, 'b1')

    emit({ event: 'output', offset: 1, text: 'ž ok\n' })
    expect(lines()).toEqual(['až ok'])
  })

  it('reads the tail again when a chunk starts past what the view holds', async () => {
    vi.mocked(api.taskOutput).mockResolvedValue({ text: 'a\n', start: 0, end: 2 })
    await useOrbital.getState().openTaskOutput(SESSION, 'b1')
    vi.mocked(api.taskOutput).mockResolvedValue({ text: 'a\nb\nc\n', start: 0, end: 6 })

    emit({ event: 'output', offset: 4, text: 'c\n' })
    await vi.waitFor(() => expect(lines()).toEqual(['a', 'b', 'c']))
    expect(api.taskOutput).toHaveBeenCalledTimes(2)
  })

  it('says gone for a file that no longer exists', async () => {
    vi.mocked(api.taskOutput).mockRejectedValue(new ApiError('gone', 410))
    await useOrbital.getState().openTaskOutput(SESSION, 'b1')
    expect(useOrbital.getState().taskOutput?.phase).toBe('gone')
  })

  it('takes the side slot from an open subagent, and gives it back the other way', async () => {
    vi.mocked(api.taskOutput).mockResolvedValue({ text: '', start: 0, end: 0 })
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    const agent: Subagent = { id: 'a1', name: 'agent', state: 'working', toolUseId: 't1', startedAt: 0 }

    await useOrbital.getState().openSubagent(SESSION, agent)
    await useOrbital.getState().openTaskOutput(SESSION, 'b1')
    expect(useOrbital.getState().subagentPanel).toBeNull()

    await useOrbital.getState().openSubagent(SESSION, agent)
    expect(useOrbital.getState().taskOutput).toBeNull()
    expect(releaseSpy).toHaveBeenCalledWith(TOPIC)
  })

  it('closes when another session is selected', async () => {
    vi.mocked(api.taskOutput).mockResolvedValue({ text: '', start: 0, end: 0 })
    await useOrbital.getState().openTaskOutput(SESSION, 'b1')
    useOrbital.setState({ ui: { ...useOrbital.getState().ui, selectedId: 'other' } })
    expect(useOrbital.getState().taskOutput).toBeNull()
    expect(releaseSpy).toHaveBeenCalledWith(TOPIC)
  })
})

describe('stopTask', () => {
  it('marks the stop pending until the SDK confirms', async () => {
    vi.mocked(api.stopTask).mockResolvedValue(undefined)
    await useOrbital.getState().stopTask(SESSION, 'b1')
    expect(api.stopTask).toHaveBeenCalledWith(SESSION, 'b1')
    expect(useOrbital.getState().stoppingTasks).toEqual({ [`${SESSION}:b1`]: true })
  })

  it('drops the pending mark on failure, quietly when the task had already ended', async () => {
    vi.mocked(api.stopTask).mockRejectedValue(new ApiError('ended', 409))
    await useOrbital.getState().stopTask(SESSION, 'b1')
    expect(useOrbital.getState().stoppingTasks).toEqual({})
    expect(useOrbital.getState().toast).toBeNull()

    vi.mocked(api.stopTask).mockRejectedValue(new ApiError('boom', 500))
    await useOrbital.getState().stopTask(SESSION, 'b1')
    expect(useOrbital.getState().toast).toMatchObject({ kind: 'error' })
  })
})
