import { describe, expect, it } from 'vitest'
import { LIMIT_SUN_COLORS_KEY, LIMIT_SUN_POSITIONS_KEY } from '../lib/experimental'
import type { ClaudeDirLimits, LimitsSnapshot } from '../lib/types'
import { HOLE_CLEARANCE } from '../map/layout'
import {
  DRAG_THRESHOLD_PX,
  SUN_SPACING,
  defaultSunPosition,
  fieldRadiusFromHole,
  mapSuns,
  sunCardPlacement,
  sunPressMoved,
} from '../map/sunModel'

const NOW = new Date(2026, 9, 20, 13, 42).getTime()
const READ = new Date(NOW - 60_000).toISOString()

const dir = (id: number, name: string, account: string | null, over: Partial<ClaudeDirLimits> = {}): ClaudeDirLimits => ({
  id,
  name,
  account,
  tracked: true,
  readAt: READ,
  stale: false,
  windows: [],
  extraUsage: null,
  waits: [],
  ...over,
})
const snap = (...dirs: ClaudeDirLimits[]): LimitsSnapshot => ({ dirs })
/** A trash for a field of this radius, on its diagonal. */
const holeFor = (radius: number) => {
  const d = (radius + HOLE_CLEARANCE) / Math.SQRT2
  return { x: d, y: -d }
}

describe('sunPressMoved', () => {
  it('keeps a press a click below the threshold, in any direction, and makes it a drag at it', () => {
    const under = DRAG_THRESHOLD_PX * 0.8
    expect(sunPressMoved(0, 0)).toBe(false)
    // Under the threshold on each axis, but past it together.
    expect(sunPressMoved(under, under)).toBe(true)
    expect(sunPressMoved(-under, 0)).toBe(false)
    expect(sunPressMoved(0, -DRAG_THRESHOLD_PX)).toBe(true)
  })
})

describe('default placement', () => {
  it('reads the field back off the trash, and none for an empty map', () => {
    expect(fieldRadiusFromHole(holeFor(7))).toBeCloseTo(7)
    expect(fieldRadiusFromHole({ x: 0, y: 0 })).toBe(0)
  })

  it('puts the row above the field, from its left edge rightwards, every sun off the field', () => {
    const radius = 12
    const row = [0, 1, 2, 3].map((i) => defaultSunPosition(i, radius))
    expect(row[0].x).toBeCloseTo(-radius)
    for (const [i, p] of row.entries()) {
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(radius)
      expect(p.y).toBe(row[0].y)
      if (i > 0) expect(p.x - row[i - 1].x).toBeCloseTo(SUN_SPACING)
    }
  })
})

describe('mapSuns', () => {
  it('gives one account one sun, yellow and without tiles, whatever colour was stored', () => {
    const settings = { [LIMIT_SUN_COLORS_KEY]: JSON.stringify({ 'a@x.com': 'red' }) }
    const suns = mapSuns(snap(dir(1, 'Work', 'a@x.com'), dir(2, 'Oncall', 'a@x.com')), settings, holeFor(3), NOW)
    expect(suns).toHaveLength(1)
    expect(suns[0]).toMatchObject({ key: 'a@x.com', color: 'yellow', tiles: [] })
  })

  it('gives each account its colour and its directories\' tiles once there are two', () => {
    const suns = mapSuns(snap(dir(1, 'Work', 'a@x.com'), dir(2, 'Oncall', 'a@x.com'), dir(3, 'Personal', 'b@x.com')), {}, holeFor(3), NOW)
    expect(suns.map((s) => s.key)).toEqual(['a@x.com', 'b@x.com'])
    expect(new Set(suns.map((s) => s.color)).size).toBe(2)
    expect(suns[0].tiles).toHaveLength(2)
    expect(suns[1].tiles).toHaveLength(1)
  })

  it('draws no sun for an account without plan limits or one never read, but keeps its colour slot', () => {
    const suns = mapSuns(
      snap(dir(1, 'Key', null, { tracked: false }), dir(2, 'New', 'n@x.com', { readAt: null }), dir(3, 'Work', 'a@x.com')),
      {},
      holeFor(3),
      NOW,
    )
    expect(suns.map((s) => s.key)).toEqual(['a@x.com'])
    // Two accounts have plan windows, so the one drawn is not "the only one".
    expect(suns[0].tiles).toHaveLength(1)
    expect(mapSuns(null, {}, holeFor(3), NOW)).toEqual([])
  })

  it('keeps a stored position when the field grows, and moves a default one with it', () => {
    const settings = { [LIMIT_SUN_POSITIONS_KEY]: JSON.stringify({ 'a@x.com': { x: -40, y: 25 } }) }
    const snapshot = snap(dir(1, 'Work', 'a@x.com'), dir(2, 'Personal', 'b@x.com'))
    const small = mapSuns(snapshot, settings, holeFor(3), NOW)
    const large = mapSuns(snapshot, settings, holeFor(30), NOW)
    expect(large[0].position).toEqual(small[0].position)
    expect(large[0].placed).toBe(true)
    expect(large[1].placed).toBe(false)
    expect(large[1].position.y).toBeGreaterThan(small[1].position.y)
  })

  it('reads a stale reading as stale', () => {
    const old = new Date(NOW - 24 * 3_600_000).toISOString()
    expect(mapSuns(snap(dir(1, 'Work', 'a@x.com', { readAt: old })), {}, holeFor(3), NOW)[0].stale).toBe(true)
  })
})

describe('sunCardPlacement', () => {
  const viewport = { width: 1440, height: 900 }
  it('puts the card right of the sun, and left of it near the right edge', () => {
    const near = sunCardPlacement({ x: 200, y: 300 }, 20, viewport)
    expect(near.left).toBeGreaterThan(200 + 20)
    const far = sunCardPlacement({ x: 1400, y: 300 }, 20, viewport)
    expect(far.left).toBeLessThan(1400 - 20)
  })

  it('keeps the card inside the map vertically', () => {
    expect(sunCardPlacement({ x: 200, y: -500 }, 20, viewport).top).toBeGreaterThan(0)
    expect(sunCardPlacement({ x: 200, y: 5000 }, 20, viewport).top).toBeLessThan(viewport.height)
  })
})
