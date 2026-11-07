import { describe, expect, it } from 'vitest'
import { BADGE_HOLD_MS, BADGE_IN_MS, BADGE_OUT_MS, badgeFrames } from '../src/badge'

describe('badgeFrames', () => {
  const frames = badgeFrames()

  it('runs in time order', () => {
    for (let i = 1; i < frames.length; i++) expect(frames[i].at).toBeGreaterThan(frames[i - 1].at)
  })

  it('shows at once and is fully in when the fade in ends', () => {
    expect(frames[0].at).toBe(0)
    expect(frames[0].opacity).toBeGreaterThan(0)
    const full = frames.find((f) => f.opacity === 1)
    expect(full?.at).toBe(BADGE_IN_MS)
  })

  it('holds, then ends on the resting icon when the fade out ends', () => {
    const afterIn = frames.filter((f) => f.at > BADGE_IN_MS)
    expect(afterIn[0].at).toBe(BADGE_IN_MS + BADGE_HOLD_MS)
    const last = frames[frames.length - 1]
    expect(last).toEqual({ at: BADGE_IN_MS + BADGE_HOLD_MS + BADGE_OUT_MS, opacity: 0 })
    for (let i = 1; i < afterIn.length; i++)
      expect(afterIn[i].opacity).toBeLessThan(afterIn[i - 1].opacity)
  })
})
