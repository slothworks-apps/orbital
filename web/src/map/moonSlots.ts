/**
 * Where a planet's moons ride: which of its few shared orbits, and where on
 * it (spec 2026-10-21-moon-orbit-limit-design). Pure — the previous
 * placement comes in, so a moon already on the map keeps its place.
 */

import { GOLDEN_ANGLE } from './layout'

export interface MoonSlot {
  /** 0 is the innermost orbit. */
  orbit: number
  /** The moon's angle relative to the orbit's own rotation, in radians, in [0, 2π). */
  phase: number
}

const TAU = Math.PI * 2

function normalize(angle: number): number {
  const a = angle % TAU
  return a < 0 ? a + TAU : a
}

/** Shortest angular distance between two angles. */
function separation(a: number, b: number): number {
  const d = Math.abs(normalize(a) - normalize(b))
  return Math.min(d, TAU - d)
}

/** The middle of the widest gap between `phases`, and that gap's width. */
function widestGap(phases: readonly number[]): { mid: number; width: number } {
  const sorted = phases.map(normalize).sort((a, b) => a - b)
  let best = { mid: 0, width: -1 }
  sorted.forEach((start, i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + TAU
    const width = end - start
    if (width > best.width) best = { mid: normalize(start + width / 2), width }
  })
  return best
}

/**
 * Places `ids` (one planet's running moons, in their order) on at most
 * `maxOrbits` orbits. `minSeparation(orbit)` is the smallest angle two moons
 * on that orbit may sit apart.
 *
 * A moon in `previous` keeps its slot while that orbit is still allowed and
 * the slot still clears the moons kept before it. Every other moon goes to
 * the allowed orbit with the fewest moons that still has room (the inner one
 * on a tie), into the middle of its widest gap; an empty orbit starts at its
 * index times the golden angle. When no allowed orbit has room, the first
 * orbit past the limit that has room takes it, so moons never touch.
 */
export function placeMoons(
  ids: readonly string[],
  previous: ReadonlyMap<string, MoonSlot>,
  maxOrbits: number,
  minSeparation: (orbit: number) => number
): Map<string, MoonSlot> {
  const slots = new Map<string, MoonSlot>()
  const onOrbit: number[][] = []
  const phasesOn = (orbit: number) => (onOrbit[orbit] ??= [])
  const clears = (orbit: number, phase: number) =>
    phasesOn(orbit).every((other) => separation(other, phase) >= minSeparation(orbit))

  const placeAt = (id: string, slot: MoonSlot) => {
    slots.set(id, slot)
    phasesOn(slot.orbit).push(slot.phase)
  }

  for (const id of ids) {
    const kept = previous.get(id)
    if (kept && kept.orbit < maxOrbits && clears(kept.orbit, kept.phase)) placeAt(id, kept)
  }

  const candidate = (orbit: number): MoonSlot | null => {
    const phases = phasesOn(orbit)
    if (phases.length === 0) return { orbit, phase: normalize(orbit * GOLDEN_ANGLE) }
    const gap = widestGap(phases)
    return gap.width >= 2 * minSeparation(orbit) ? { orbit, phase: gap.mid } : null
  }

  for (const id of ids) {
    if (slots.has(id)) continue
    let chosen: MoonSlot | null = null
    for (let orbit = 0; orbit < maxOrbits; orbit++) {
      const slot = candidate(orbit)
      if (slot && (!chosen || phasesOn(orbit).length < phasesOn(chosen.orbit).length)) chosen = slot
    }
    for (let orbit = maxOrbits; !chosen; orbit++) chosen = candidate(orbit)
    placeAt(id, chosen)
  }

  return slots
}
