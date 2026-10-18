import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAsOfNow } from '../lib/asOfClock'
import { AS_OF_TICK_MS } from '../lib/devices'

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

afterEach(() => {
  setHidden(false)
  vi.useRealTimers()
})

describe('useAsOfNow', () => {
  it('runs one interval for every reader, none while the window is hidden, and reads the time on coming back', () => {
    vi.useFakeTimers({ now: 1_000 })
    const a = renderHook(() => useAsOfNow(true))
    const b = renderHook(() => useAsOfNow(true))
    const idle = renderHook(() => useAsOfNow(false))
    expect(vi.getTimerCount()).toBe(1)
    act(() => {
      vi.advanceTimersByTime(AS_OF_TICK_MS)
    })
    expect([a.result.current, b.result.current]).toEqual([1_000 + AS_OF_TICK_MS, 1_000 + AS_OF_TICK_MS])

    setHidden(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(5 * AS_OF_TICK_MS)
    setHidden(false)
    expect(vi.getTimerCount()).toBe(1)
    expect(a.result.current).toBe(5 * AS_OF_TICK_MS)

    a.unmount()
    b.unmount()
    idle.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
