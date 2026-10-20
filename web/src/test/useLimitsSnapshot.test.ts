import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { LimitsSnapshot } from '../lib/types'

const watchers = new Set<(msg: unknown) => void>()
const getLimits = vi.fn<() => Promise<LimitsSnapshot>>()
vi.mock('../lib/api', () => ({ api: { getLimits: () => getLimits(), refreshLimits: vi.fn() } }))
vi.mock('../lib/errors', () => ({ recordError: vi.fn() }))
vi.mock('../lib/socket', () => ({
  getSocket: () => ({
    subscribe: (_topic: string, cb: (msg: unknown) => void) => {
      watchers.add(cb)
      return () => watchers.delete(cb)
    },
    onStatusChange: (cb: (status: string) => void) => {
      cb('open')
      return () => {}
    },
  }),
}))

import { useLimitsSnapshot } from '../lib/useLimitsSnapshot'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  setVisibility('visible')
  watchers.clear()
  getLimits.mockReset()
})

describe('useLimitsSnapshot', () => {
  it('lets go of the topic while the page is hidden, and reads and watches again once shown', async () => {
    getLimits.mockResolvedValue({ dirs: [] })
    const { result, unmount } = renderHook(() => useLimitsSnapshot())
    await act(async () => {})
    expect(watchers.size).toBe(1)
    expect(getLimits).toHaveBeenCalledTimes(1)
    expect(result.current.snapshot).toEqual({ dirs: [] })

    act(() => setVisibility('hidden'))
    expect(watchers.size).toBe(0)

    await act(async () => setVisibility('visible'))
    expect(watchers.size).toBe(1)
    expect(getLimits).toHaveBeenCalledTimes(2)

    unmount()
    expect(watchers.size).toBe(0)
  })

  it('records a failed read and says so until a frame lands', async () => {
    getLimits.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useLimitsSnapshot())
    await act(async () => {})
    expect(result.current.failed).toBe('boom')
    const { recordError } = await import('../lib/errors')
    expect(recordError).toHaveBeenCalled()
    act(() => watchers.forEach((cb) => cb({ event: 'limits', limits: { dirs: [] } })))
    expect(result.current.failed).toBeNull()
    expect(result.current.snapshot).toEqual({ dirs: [] })
  })
})
