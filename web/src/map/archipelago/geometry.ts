import type { SessionStateKey } from '../../lib/types'

/**
 * Pure geometry for the Archipelago theme (spec 2026-10-01-map-themes-design
 * § 3): the shape of an island, where its pier stands, which berth a ship
 * takes in each state, and the way round an island rather than across it.
 *
 * Everything is in map world units with y pointing up — the same space the
 * planet map and `camera.ts` use, so the shared camera, fit and history drop
 * work unchanged. Angles are standard maths angles (counter-clockwise from +x).
 * Deterministic: no Date.now, no Math.random; the same input always gives the
 * same output, so a ship never jumps between renders.
 */

export interface Point {
  x: number
  y: number
}

export interface Island {
  tagId: number
  /** Centre, in world units. */
  x: number
  y: number
  /** Mean coast radius. The coast wobbles ±27 % around it (`coastRadius`). */
  radius: number
  /** Shape seed, derived from the tag so an island keeps its outline. */
  seed: number
  /** Angle the harbour faces — toward the archipelago's centre. */
  harbour: number
}

/** Ship hull length in world units: what berths and orbits are spaced by. */
export const SHIP_LENGTH = 1.3
/** The coast never reaches further than this times the mean radius. */
export const COAST_MAX = 1.27
/** Pier length from the coast, in world units. */
export const PIER_LENGTH = 1.7
/** Clear water kept between two islands' outermost sailing rings. */
export const ISLAND_GAP = 0.8

/** Mean coast radius for an island holding `sessions` sessions. Grows by area, not by count. */
export function islandRadius(sessions: number): number {
  return 2.6 + 0.7 * Math.sqrt(Math.max(0, sessions))
}

/** Shape seed for a tag: a fixed spread of phases, so neighbouring tags look unalike. */
export function islandSeed(tagId: number): number {
  return ((tagId * 2.39996) % (Math.PI * 2)) + 0.7
}

/** The coast's distance from the island centre at `theta`. */
export function coastRadius(island: Island, theta: number): number {
  const s = island.seed
  return (
    island.radius *
    (1 + 0.14 * Math.sin(3 * theta + s) + 0.08 * Math.sin(5 * theta + 2 * s) + 0.05 * Math.sin(8 * theta + 3 * s))
  )
}

/** The coast as a closed polygon, `steps` points, scaled by `k` (1 = the coast). */
export function coastPolygon(island: Island, k = 1, steps = 96): Point[] {
  const out: Point[] = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    out.push(polar(island, t, coastRadius(island, t) * k))
  }
  return out
}

export function polar(c: Point, angle: number, r: number): Point {
  return { x: c.x + Math.cos(angle) * r, y: c.y + Math.sin(angle) * r }
}

/** Signed shortest turn from `b` to `a`, in (-π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}

/** Where the harbour faces: toward `centre`, or due south when the island is the centre. */
export function harbourAngle(island: Point, centre: Point): number {
  const dx = centre.x - island.x
  const dy = centre.y - island.y
  if (Math.hypot(dx, dy) < 1e-6) return -Math.PI / 2
  return Math.atan2(dy, dx)
}

/** The pier: where it leaves the coast, the unit direction it points, and its length. */
export function pier(island: Island): { from: Point; dir: Point; length: number } {
  const h = island.harbour
  return {
    from: polar(island, h, coastRadius(island, h) * 0.97),
    dir: { x: Math.cos(h), y: Math.sin(h) },
    length: PIER_LENGTH,
  }
}

/** The radius every route keeps to, so a ship never crosses the coast or the pier. */
export function safeRadius(island: Island): number {
  return Math.max(island.radius * COAST_MAX, coastRadius(island, island.harbour) + PIER_LENGTH) + SHIP_LENGTH * 0.8
}

/** The radius of the `k`-th sailing ring — where working ships circle. */
export function orbitRadius(island: Island, k: number): number {
  return safeRadius(island) + SHIP_LENGTH * 0.9 + k * SHIP_LENGTH * 0.95
}

/**
 * The outermost thing an island draws: its last sailing ring plus a hull.
 * What separation and fit measure an island by.
 */
export function islandReach(island: Island, workingShips: number): number {
  return orbitRadius(island, Math.max(0, workingShips - 1)) + SHIP_LENGTH * 0.6
}

/**
 * The factor the cluster anchors are spread by so no two islands' reaches
 * overlap. Never below 1, so the archipelago is never denser than the planet
 * map; and the same anchors with the same reaches always give the same factor.
 */
export function spreadFactor(centres: Point[], reaches: number[], gap = ISLAND_GAP): number {
  let f = 1
  for (let i = 0; i < centres.length; i++) {
    for (let j = i + 1; j < centres.length; j++) {
      const d = Math.hypot(centres[i].x - centres[j].x, centres[i].y - centres[j].y)
      const need = reaches[i] + reaches[j] + gap
      if (d < 1e-6) continue
      f = Math.max(f, need / d)
    }
  }
  return f
}

/** Where a ship should be, by state. `orbit` is followed over time; the rest are fixed. */
export type Berth =
  | { kind: 'orbit'; radius: number; direction: 1 | -1 }
  | { kind: 'fixed'; at: Point; heading: number }

/**
 * The bucket a state's ships queue in for berths; ships in one bucket get
 * indices 0, 1, 2… An ended ship on the map is one leaving, which stays where
 * it is while it fades, so `ended` anchors aside.
 */
export function berthGroup(state: SessionStateKey): 'orbit' | 'hove' | 'pier' | 'roads' | 'bay' | 'aside' {
  switch (state) {
    case 'working':
      return 'orbit'
    case 'waiting':
      return 'hove'
    case 'needs_input':
    case 'done':
      return 'pier'
    case 'interrupted':
      return 'roads'
    case 'idle':
      return 'bay'
    case 'ended':
      return 'aside'
  }
}

/**
 * The berth of the `index`-th ship of `group` on `island`.
 *
 * - orbit: concentric sailing rings, alternate directions so neighbours pass.
 * - hove: hove-to stations off the island, fanned out beside the harbour.
 * - pier: the two berths alongside the pier, then moorings along the coast
 *   on the harbour's right.
 * - roads: anchored off the pier head.
 * - bay: moored in the bay on the harbour's left.
 * - aside: anchored further round, behind the island, out of the way.
 */
export function berthFor(island: Island, group: ReturnType<typeof berthGroup>, index: number): Berth {
  const h = island.harbour
  const tangent = (a: number) => a + Math.PI / 2
  const moor = (angle: number, off: number): Berth => ({
    kind: 'fixed',
    at: polar(island, angle, coastRadius(island, angle) + off),
    heading: tangent(angle),
  })
  switch (group) {
    case 'orbit':
      return { kind: 'orbit', radius: orbitRadius(island, index), direction: index % 2 === 0 ? 1 : -1 }
    case 'hove': {
      const a = h + 1.0 + index * 0.4
      return { kind: 'fixed', at: polar(island, a, safeRadius(island) + SHIP_LENGTH * 0.3), heading: tangent(a) }
    }
    case 'pier': {
      if (index < 2) {
        const p = pier(island)
        const side = index === 0 ? 1 : -1
        const along = p.length * 0.62
        const n = { x: -p.dir.y, y: p.dir.x }
        const off = SHIP_LENGTH * 0.32
        return {
          kind: 'fixed',
          at: { x: p.from.x + p.dir.x * along + n.x * off * side, y: p.from.y + p.dir.y * along + n.y * off * side },
          heading: h,
        }
      }
      return moor(h - 0.55 - (index - 2) * 0.36, SHIP_LENGTH * 0.55)
    }
    case 'roads': {
      const p = pier(island)
      const a = h + (index % 2 === 0 ? 1 : -1) * (0.18 + Math.floor(index / 2) * 0.16)
      const r = coastRadius(island, h) + p.length + SHIP_LENGTH * 0.9
      return { kind: 'fixed', at: polar(island, a, r), heading: tangent(a) }
    }
    case 'bay':
      return moor(h + 1.15 + index * 0.32, SHIP_LENGTH * 0.6)
    case 'aside':
      return moor(h + Math.PI + 0.25 + index * 0.32, SHIP_LENGTH * 0.6)
  }
}

/** Where a working ship circling at `berth` stands at `phase` (radians round the ring). */
export function orbitPoint(island: Island, radius: number, phase: number): Point {
  return polar(island, phase, radius)
}

/**
 * The next waypoint from `from` toward `to` that keeps clear of the island:
 * when the two are on different sides, step along the safe ring first; once
 * within a short arc of the target bearing, head straight for it. Call it
 * every frame with the ship's current position — it never returns a point
 * whose straight line crosses the coast.
 */
export function routeStep(island: Island, from: Point, to: Point): Point {
  const a = Math.atan2(from.y - island.y, from.x - island.x)
  const r = Math.hypot(from.x - island.x, from.y - island.y)
  const target = Math.atan2(to.y - island.y, to.x - island.x)
  const d = angleDiff(target, a)
  const safe = safeRadius(island)
  if (Math.abs(d) > 0.35) return polar(island, a + Math.sign(d) * 0.45, Math.max(r, safe))
  return to
}

/** A landing spot on the beach at `theta`, just off the coast — where a rowboat scouts. */
export function shorePoint(island: Island, theta: number): Point {
  return polar(island, theta, coastRadius(island, theta) * 1.02 + 0.22)
}

/** Whether `p` is on land. */
export function onLand(island: Island, p: Point): boolean {
  const theta = Math.atan2(p.y - island.y, p.x - island.x)
  return Math.hypot(p.x - island.x, p.y - island.y) < coastRadius(island, theta)
}
