import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ApiSession, Walkthrough } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

const handlers = new Map<string, (msg: unknown) => void>()
vi.mock('../lib/socket', () => ({
  getSocket: () => ({
    subscribe: (topic: string, cb: (msg: unknown) => void) => { handlers.set(topic, cb); return () => handlers.delete(topic) },
    onStatusChange: () => () => {},
  }),
}))

import { api, ApiError } from '../lib/api'
import { useWalkthrough, WALKTHROUGH_REFETCH_DEBOUNCE_MS } from '../walkthrough/useWalkthrough'

const session = { id: 'w1', title: 't', status: 'idle', source: 'web', cwd: '/w', ide: null, subagents: [] } as unknown as ApiSession
const empty: Walkthrough = { steps: [], timeline: [], files: [], narration: null, narrationFailed: false, narrationPending: false, narrationFailure: null, lastMessageId: null }

beforeEach(() => { handlers.clear(); vi.clearAllMocks(); vi.useFakeTimers() })

describe('useWalkthrough', () => {
  it('fetches once on mount and again, debounced, when the session speaks', async () => {
    vi.mocked(api.getWalkthrough).mockResolvedValue({ session, walkthrough: empty })
    const { result } = renderHook(() => useWalkthrough('w1'))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(api.getWalkthrough).toHaveBeenCalledTimes(1)
    expect(result.current.walkthrough).toEqual(empty)

    act(() => {
      handlers.get('session:w1')!({ event: 'message', message: { id: 'm1', role: 'assistant', text: 'x' } })
      handlers.get('session:w1')!({ event: 'message', message: { id: 'm2', role: 'assistant', text: 'y' } })
    })
    expect(api.getWalkthrough).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(WALKTHROUGH_REFETCH_DEBOUNCE_MS + 1); await Promise.resolve() })
    expect(api.getWalkthrough).toHaveBeenCalledTimes(2)
  })

  it('refetches when a narrate query starts or lands', async () => {
    vi.mocked(api.getWalkthrough).mockResolvedValue({ session, walkthrough: empty })
    renderHook(() => useWalkthrough('w1'))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    act(() => { handlers.get('session:w1')!({ event: 'walkthrough_narration' }) })
    await act(async () => { vi.advanceTimersByTime(WALKTHROUGH_REFETCH_DEBOUNCE_MS + 1); await Promise.resolve() })
    expect(api.getWalkthrough).toHaveBeenCalledTimes(2)
  })

  it('takes a sessions upsert for this id without refetching', async () => {
    vi.mocked(api.getWalkthrough).mockResolvedValue({ session, walkthrough: empty })
    const { result } = renderHook(() => useWalkthrough('w1'))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    act(() => { handlers.get('sessions')!({ event: 'upsert', session: { ...session, status: 'working' } }) })
    expect(result.current.session?.status).toBe('working')
    expect(api.getWalkthrough).toHaveBeenCalledTimes(1)
  })

  it('reports not_found on a 404 and failed otherwise', async () => {
    vi.mocked(api.getWalkthrough).mockRejectedValueOnce(new ApiError('nf', 404))
    const a = renderHook(() => useWalkthrough('w1'))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(a.result.current.error).toBe('not_found')
    vi.mocked(api.getWalkthrough).mockRejectedValueOnce(new Error('boom'))
    const b = renderHook(() => useWalkthrough('w2'))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(b.result.current.error).toBe('failed')
  })
})
