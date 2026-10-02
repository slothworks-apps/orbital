import { describe, it, expect } from 'vitest'
import {
  berthFor,
  berthGroup,
  coastRadius,
  harbourAngle,
  islandRadius,
  islandReach,
  islandSeed,
  onLand,
  routeStep,
  safeRadius,
  spreadFactor,
  type Island,
  type Point,
} from '../map/archipelago/geometry'

function island(over: Partial<Island> = {}): Island {
  const base = { tagId: 1, x: 0, y: 0, radius: islandRadius(4), seed: islandSeed(1), harbour: 0 }
  return { ...base, ...over }
}

/** Does the straight segment a→b touch land anywhere? Sampled finely. */
function crossesLand(i: Island, a: Point, b: Point): boolean {
  for (let t = 0; t <= 1; t += 0.01) {
    if (onLand(i, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return true
  }
  return false
}

describe('archipelago geometry', () => {
  it('grows an island with its sessions, slower than linearly', () => {
    expect(islandRadius(4)).toBeGreaterThan(islandRadius(1))
    expect(islandRadius(16) - islandRadius(4)).toBeLessThan(islandRadius(4) - islandRadius(0) + 1e-9)
  })

  it('keeps the safe ring outside every point of the coast and the pier', () => {
    for (const tagId of [1, 2, 3, 7, 42]) {
      const i = island({ tagId, seed: islandSeed(tagId), harbour: tagId })
      const safe = safeRadius(i)
      for (let t = 0; t < Math.PI * 2; t += 0.05) expect(coastRadius(i, t)).toBeLessThan(safe)
    }
  })

  it('maps every state to a berth group, ended included', () => {
    expect(berthGroup('working')).toBe('orbit')
    expect(berthGroup('waiting')).toBe('hove')
    expect(berthGroup('needs_input')).toBe('pier')
    expect(berthGroup('done')).toBe('pier')
    expect(berthGroup('interrupted')).toBe('roads')
    expect(berthGroup('idle')).toBe('bay')
    expect(berthGroup('ended')).toBe('aside')
  })

  it('puts no fixed berth on land, and no two berths of one island on top of each other', () => {
    const i = island({ harbour: 0.8 })
    const spots: Point[] = []
    for (const group of ['hove', 'pier', 'roads', 'bay', 'aside'] as const) {
      for (let k = 0; k < 5; k++) {
        const b = berthFor(i, group, k)
        if (b.kind !== 'fixed') throw new Error('expected a fixed berth')
        expect(onLand(i, b.at)).toBe(false)
        spots.push(b.at)
      }
    }
    for (let a = 0; a < spots.length; a++) {
      for (let b = a + 1; b < spots.length; b++) {
        expect(Math.hypot(spots[a].x - spots[b].x, spots[a].y - spots[b].y)).toBeGreaterThan(0.7)
      }
    }
  })

  it('overflows the pier onto coast moorings after two ships', () => {
    const i = island()
    const pierBerths = [0, 1].map((k) => berthFor(i, 'pier', k))
    const third = berthFor(i, 'pier', 2)
    for (const b of pierBerths) if (b.kind === 'fixed') expect(b.heading).toBe(i.harbour)
    if (third.kind === 'fixed') expect(third.heading).not.toBe(i.harbour)
  })

  it('stacks working ships on separate rings, alternating direction', () => {
    const i = island()
    const a = berthFor(i, 'orbit', 0)
    const b = berthFor(i, 'orbit', 1)
    if (a.kind !== 'orbit' || b.kind !== 'orbit') throw new Error('expected orbits')
    expect(b.radius).toBeGreaterThan(a.radius)
    expect(a.direction).toBe(-b.direction)
  })

  it('routes round the island: no step ever crosses land, and it arrives', () => {
    const i = island({ harbour: Math.PI / 3 })
    const target = berthFor(i, 'pier', 0)
    if (target.kind !== 'fixed') throw new Error('expected a fixed berth')
    // Start on the far side of the island from the harbour.
    let at = { x: -safeRadius(i) - 1, y: 0.2 }
    let arrived = false
    for (let step = 0; step < 400; step++) {
      const next = routeStep(i, at, target.at)
      // Advance a short way toward the waypoint, the way a ship would.
      const dx = next.x - at.x
      const dy = next.y - at.y
      const d = Math.hypot(dx, dy)
      const move = Math.min(d, 0.12)
      const to = d < 1e-9 ? at : { x: at.x + (dx / d) * move, y: at.y + (dy / d) * move }
      expect(crossesLand(i, at, to)).toBe(false)
      at = to
      if (Math.hypot(at.x - target.at.x, at.y - target.at.y) < 1e-6) {
        arrived = true
        break
      }
    }
    expect(arrived).toBe(true)
  })

  it('faces the harbour toward the archipelago centre', () => {
    expect(harbourAngle({ x: -5, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(0)
    expect(harbourAngle({ x: 0, y: 5 }, { x: 0, y: 0 })).toBeCloseTo(-Math.PI / 2)
    expect(harbourAngle({ x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(-Math.PI / 2)
  })

  it('spreads anchors just enough that no two reaches overlap, never denser than 1', () => {
    const i = island()
    const reach = islandReach(i, 2)
    const centres = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 40 }]
    const f = spreadFactor(centres, [reach, reach, reach])
    expect(Math.hypot(3 * f, 0)).toBeGreaterThanOrEqual(2 * reach)
    expect(spreadFactor([{ x: 0, y: 0 }, { x: 500, y: 0 }], [reach, reach])).toBe(1)
  })
})
