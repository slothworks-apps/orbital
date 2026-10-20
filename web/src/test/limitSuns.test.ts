import { describe, expect, it } from 'vitest'
import { LIMIT_SUN_COLORS_KEY, LIMIT_SUN_POSITIONS_KEY } from '../lib/experimental'
import { estimateLine } from '../lib/limits'
import { pickSunColor, sunColors, sunPositions, sunReading, withSunMoveUndone, withSunPosition } from '../lib/limitSuns'
import type { LimitWindow } from '../lib/types'

// Local times, so "today" is today whatever zone the suite runs in.
const NOW = new Date(2026, 9, 20, 13, 42).getTime()
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString()

const win = (kind: string, percent: number, over: Partial<LimitWindow> = {}): LimitWindow => ({
  kind, label: kind, percent, resetsAt: at(20, 15), severity: 'normal', ...over,
})

describe('sunColors', () => {
  it('gives accounts the free colours in order, keeping a stored one unless an earlier account holds it', () => {
    expect([...sunColors(['a', 'b', 'c'], {}).values()]).toEqual(['yellow', 'white', 'blue'])
    const stored = { [LIMIT_SUN_COLORS_KEY]: JSON.stringify({ b: 'yellow', c: 'yellow', z: 'red' }) }
    expect(Object.fromEntries(sunColors(['a', 'b', 'c'], stored))).toEqual({ b: 'yellow', a: 'white', c: 'blue' })
  })

  it('keeps a lone account on the first colour, whatever is stored', () => {
    expect(sunColors(['a'], { [LIMIT_SUN_COLORS_KEY]: '{"a":"red"}' }).get('a')).toBe('yellow')
  })

  it('repeats the colours past four accounts, and ignores what it cannot read', () => {
    expect(sunColors(['a', 'b', 'c', 'd', 'e'], {}).get('e')).toBe('yellow')
    expect(sunColors(['a', 'b'], { [LIMIT_SUN_COLORS_KEY]: '{not json' }).get('a')).toBe('yellow')
    expect(sunColors(['a', 'b'], { [LIMIT_SUN_COLORS_KEY]: '{"b":"green"}' }).get('b')).toBe('white')
  })

  it('swaps two accounts when one picks the colour the other wears', () => {
    const keys = ['a', 'b']
    const once = { [LIMIT_SUN_COLORS_KEY]: pickSunColor(keys, {}, 'b', 'yellow') }
    expect(Object.fromEntries(sunColors(keys, once))).toEqual({ a: 'white', b: 'yellow' })
    // Holds when the accounts come in the other order.
    expect(Object.fromEntries(sunColors(['b', 'a'], once))).toEqual({ a: 'white', b: 'yellow' })
    const free = { [LIMIT_SUN_COLORS_KEY]: pickSunColor(keys, once, 'a', 'red') }
    expect(Object.fromEntries(sunColors(keys, free))).toEqual({ a: 'red', b: 'yellow' })
  })
})

describe('withSunMoveUndone', () => {
  const placed = { x: 1, y: 2 }
  const before = { x: 5, y: 6 }
  const after = (settings: Record<string, string>, key: string, p: { x: number; y: number }) => ({
    [LIMIT_SUN_POSITIONS_KEY]: withSunPosition(settings, key, p),
  })

  it('puts the sun back where it was, or drops it, and leaves the other suns', () => {
    const start = { [LIMIT_SUN_POSITIONS_KEY]: JSON.stringify({ a: before, b: { x: 9, y: 9 } }) }
    const undone = withSunMoveUndone(after(start, 'a', placed), 'a', placed, before)
    expect(Object.fromEntries(sunPositions({ [LIMIT_SUN_POSITIONS_KEY]: undone! }))).toEqual({ a: before, b: { x: 9, y: 9 } })
    const fresh = withSunMoveUndone(after({}, 'a', placed), 'a', placed, undefined)
    expect(sunPositions({ [LIMIT_SUN_POSITIONS_KEY]: fresh! }).has('a')).toBe(false)
  })

  it('keeps a later move of the same sun, and a later move of another sun', () => {
    const moved = after({}, 'a', placed)
    expect(withSunMoveUndone(after(moved, 'a', { x: 3, y: 3 }), 'a', placed, before)).toBeNull()
    const other = withSunMoveUndone(after(moved, 'b', { x: 7, y: 7 }), 'a', placed, undefined)
    expect(Object.fromEntries(sunPositions({ [LIMIT_SUN_POSITIONS_KEY]: other! }))).toEqual({ b: { x: 7, y: 7 } })
  })
})

describe('sunReading', () => {
  it('takes the middle from the more spent of the 5-hour and the weekly window, the ring from the week', () => {
    const r = sunReading([win('session', 62, { severity: 'warning' }), win('weekly_all', 40), win('weekly_scoped', 99)], NOW)
    expect(r).toEqual({ spentNow: 0.62, weekLeft: 0.6, label: '5h 62 % · wk 40 %', severity: 'warning' })
    expect(sunReading([win('session', 20), win('weekly_all', 92)], NOW).spentNow).toBe(0.92)
  })

  it('names the reset once a window is spent, the later one when both are', () => {
    expect(sunReading([win('session', 100), win('weekly_all', 72, { resetsAt: at(22, 9) })], NOW).label).toBe('limit · resets 15:00')
    const both = sunReading([win('session', 100), win('weekly_all', 100, { resetsAt: at(22, 9) })], NOW)
    expect(both).toMatchObject({ spentNow: 1, weekLeft: 0, label: 'limit · resets Thu 09:00', severity: 'reached' })
  })
})

describe('estimateLine', () => {
  it('rounds a run-out to ten minutes for the 5-hour window and to the hour for a weekly one', () => {
    expect(estimateLine({ kind: 'session', estimate: { runsOutAt: at(20, 14, 16), basis: 'recent' } }, false, NOW))
      .toEqual({ kind: 'runs', at: '~14:20' })
    expect(estimateLine({ kind: 'weekly_all', estimate: { runsOutAt: at(21, 15, 40), basis: 'window' } }, false, NOW))
      .toEqual({ kind: 'runs', at: '~Wed 16:00' })
  })

  it('says it lasts, when it ran out, or that the reading is out of date', () => {
    expect(estimateLine({ kind: 'session', estimate: { runsOutAt: null, basis: 'window' } }, false, NOW)).toEqual({ kind: 'lasts' })
    expect(estimateLine({ kind: 'session', estimate: { runsOutAt: null, basis: 'recent', ranOutAt: at(20, 13, 5) } }, false, NOW))
      .toEqual({ kind: 'ran', at: '13:05' })
    expect(estimateLine({ kind: 'session', estimate: { runsOutAt: null, basis: 'window' } }, true, NOW)).toEqual({ kind: 'stale' })
    // An older Mac sends no estimate at all: nothing to say, stale or not.
    expect(estimateLine({ kind: 'session' }, true, NOW)).toBeNull()
    expect(estimateLine({ kind: 'session', estimate: null }, false, NOW)).toBeNull()
  })
})

describe('the limits route', () => {
  it('opens at an account through its path, the key encoded', async () => {
    const { limitsPathFor, parseLimitsRoute } = await import('../limits/route')
    expect(parseLimitsRoute('/limits')).toEqual({ account: null })
    expect(parseLimitsRoute('/limits/')).toEqual({ account: null })
    expect(limitsPathFor('self:3')).toBe('/limits/self%3A3')
    expect(parseLimitsRoute(limitsPathFor('jan+work@acme.com'))).toEqual({ account: 'jan+work@acme.com' })
    expect(parseLimitsRoute('/limits/a/b')).toBeNull()
    expect(parseLimitsRoute('/limits/%E0%A4%A')).toBeNull()
    expect(parseLimitsRoute('/limitsx')).toBeNull()
  })
})
