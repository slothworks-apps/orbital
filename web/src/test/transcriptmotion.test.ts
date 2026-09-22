import { describe, it, expect } from 'vitest'
import { approach, enteringKeys, isNearBottom, compensatePrepend } from '../panels/transcriptMotion'

describe('isNearBottom', () => {
  it('is true within the threshold of the bottom', () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
    expect(isNearBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 }, 80)).toBe(true)
  })

  it('is false further up than that', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(false)
  })
})

describe('compensatePrepend', () => {
  it('grows scrollTop by exactly what was added above', () => {
    expect(compensatePrepend(1000, 1300, 400)).toBe(700)
  })

  it('leaves scrollTop alone when nothing grew', () => {
    expect(compensatePrepend(1000, 1000, 400)).toBe(400)
  })
})

describe('approach', () => {
  const HALF_LIFE = 100

  it('covers exactly half the remaining distance in one half-life', () => {
    expect(approach(0, 100, HALF_LIFE, HALF_LIFE)).toBeCloseTo(50, 6)
  })

  it('lands in the same place whatever the frame rate', () => {
    // The whole point of the exponential form: two 8ms steps (a 120fps
    // display) must leave the scroller exactly where one 16ms step (60fps)
    // does, or the animation runs at a speed that depends on the monitor.
    const fast = approach(approach(0, 500, 8, HALF_LIFE), 500, 8, HALF_LIFE)
    const slow = approach(0, 500, 16, HALF_LIFE)
    expect(fast).toBeCloseTo(slow, 6)

    // And across a longer stretch, where a naive per-frame lerp would have
    // drifted far apart by now.
    let stepped = 0
    for (let i = 0; i < 24; i += 1) stepped = approach(stepped, 500, 4, HALF_LIFE)
    expect(stepped).toBeCloseTo(approach(0, 500, 96, HALF_LIFE), 6)
  })

  it('snaps to the target once the remainder is below half a pixel', () => {
    // Exponential decay never actually arrives; without the snap the loop
    // would run forever, a rAF burning frames on sub-pixel deltas.
    expect(approach(99.8, 100, 1, HALF_LIFE)).toBe(100)
    expect(approach(100, 100, 16, HALF_LIFE)).toBe(100)
  })

  it('works the same way scrolling up as down', () => {
    expect(approach(100, 0, HALF_LIFE, HALF_LIFE)).toBeCloseTo(50, 6)
  })
})

describe('enteringKeys', () => {
  it('returns the run of keys appended at the end', () => {
    expect(enteringKeys(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'd'])
  })

  it('returns nothing for the first render of a session', () => {
    // `null` is "we have never rendered this session", distinct from "this
    // session rendered empty" — otherwise selecting a session would light up
    // its entire backlog at once.
    expect(enteringKeys(null, ['a', 'b', 'c'])).toEqual([])
  })

  it('animates the first message of a session that really was empty', () => {
    expect(enteringKeys([], ['a'])).toEqual(['a'])
  })

  it('ignores keys prepended by "load older"', () => {
    expect(enteringKeys(['c', 'd'], ['a', 'b', 'c', 'd'])).toEqual([])
  })

  it('animates only the appended end when a prepend and an append land together', () => {
    expect(enteringKeys(['c'], ['a', 'b', 'c', 'd'])).toEqual(['d'])
  })

  it('still animates the append that evicted the window\'s oldest item', () => {
    // At the window cap a new message at the bottom pushes the oldest one
    // out of the top. The appended key is new; the vanished one is not a
    // reason to skip it.
    expect(enteringKeys(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['d'])
  })

  it('returns nothing when the list did not change', () => {
    expect(enteringKeys(['a', 'b'], ['a', 'b'])).toEqual([])
  })

  it('returns nothing when the last key is unchanged but earlier ones are new', () => {
    // A re-keyed row in the middle is not an arrival at the bottom; only a
    // trailing run counts.
    expect(enteringKeys(['a', 'b'], ['a', 'x', 'b'])).toEqual([])
  })
})
