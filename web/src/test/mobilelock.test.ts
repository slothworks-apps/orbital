import { describe, expect, it } from 'vitest'
import { APP_LOCK_GRACE_MS } from '../mobile/constants'
import { lockAtStart, lockOnBackground, lockOnForeground, lockOnReturn } from '../mobile/lock'

// The clock is injected: `now` and `backgroundedAt` are plain numbers.
const AWAY = 10_000

describe('when the app lock asks', () => {
  it('asks on a cold start only with the lock on', () => {
    expect(lockAtStart(true)).toBe('prompt')
    expect(lockAtStart(false)).toBe('open')
  })

  it('asks after more than the grace in the background, not after a quick switch', () => {
    const at = (gone: number) => lockOnForeground({ enabled: true, backgroundedAt: AWAY, now: AWAY + gone })
    expect(at(1_000)).toBe(false)
    expect(at(APP_LOCK_GRACE_MS)).toBe(false)
    expect(at(APP_LOCK_GRACE_MS + 1)).toBe(true)
  })

  it('never asks with the setting off, however long the app was away', () => {
    expect(lockOnForeground({ enabled: false, backgroundedAt: AWAY, now: AWAY + 10 * APP_LOCK_GRACE_MS })).toBe(false)
  })

  it('does not ask on a foreground it never saw leave', () => {
    expect(lockOnForeground({ enabled: true, backgroundedAt: null, now: AWAY })).toBe(false)
  })
})

describe('the lock across a trip to the background', () => {
  const back = (lock: Parameters<typeof lockOnReturn>[0], gone: number, enabled = true) =>
    lockOnReturn(lock, { enabled, backgroundedAt: AWAY, now: AWAY + gone })

  it('covers an open app on the way out, so the snapshot shows 9t', () => {
    expect(lockOnBackground('open', true)).toBe('covered')
    expect(lockOnBackground('open', false)).toBe('open')
  })

  it('keeps a lock that was never opened locked on the way out', () => {
    expect(lockOnBackground('locked', true)).toBe('locked')
    // A prompt that was due but never opened is a plain lock until the app is back.
    expect(lockOnBackground('prompt', true)).toBe('locked')
  })

  it('uncovers after a quick return and asks after a long one', () => {
    expect(back('covered', 1_000)).toBe('open')
    expect(back('covered', APP_LOCK_GRACE_MS + 1)).toBe('prompt')
  })

  it('does not unlock a cancelled lock on a quick return; asks again after a long one', () => {
    expect(back('locked', 1_000)).toBe('locked')
    expect(back('locked', APP_LOCK_GRACE_MS + 1)).toBe('prompt')
  })

  it('leaves an open app open', () => {
    expect(back('open', APP_LOCK_GRACE_MS + 1)).toBe('open')
  })

  it('drops the lock once it no longer applies (the pair is gone)', () => {
    expect(back('locked', 1_000, false)).toBe('open')
  })
})
