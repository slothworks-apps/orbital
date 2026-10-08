import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PausableTimer } from '../lib/pausableTimer'

describe('PausableTimer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires once its time has run', () => {
    const fired = vi.fn()
    new PausableTimer(8000, fired).resume()
    vi.advanceTimersByTime(7999)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledOnce()
  })

  it('stops while paused and goes on with what was left, never starting over', () => {
    const fired = vi.fn()
    const timer = new PausableTimer(8000, fired)
    timer.resume()
    vi.advanceTimersByTime(5000)
    timer.pause()
    vi.advanceTimersByTime(60_000)
    expect(fired).not.toHaveBeenCalled()
    timer.resume()
    vi.advanceTimersByTime(2999)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledOnce()
  })

  it('ignores a second resume while running, and fires nothing once cancelled', () => {
    const fired = vi.fn()
    const timer = new PausableTimer(1000, fired)
    timer.resume()
    vi.advanceTimersByTime(600)
    timer.resume()
    vi.advanceTimersByTime(400)
    expect(fired).toHaveBeenCalledOnce()

    const cancelled = vi.fn()
    const other = new PausableTimer(1000, cancelled)
    other.resume()
    other.cancel()
    other.resume()
    vi.advanceTimersByTime(5000)
    expect(cancelled).not.toHaveBeenCalled()
  })
})
