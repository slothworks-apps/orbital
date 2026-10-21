import { describe, expect, it } from 'vitest'
import { placeMoons, type MoonSlot } from '../map/moonSlots'

const SEP = 0.5
const sep = () => SEP
const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`)

function gap(a: number, b: number) {
  const d = Math.abs(a - b) % (2 * Math.PI)
  return Math.min(d, 2 * Math.PI - d)
}

function assertApart(slots: Map<string, MoonSlot>) {
  const all = [...slots.values()]
  for (const a of all)
    for (const b of all)
      if (a !== b && a.orbit === b.orbit) expect(gap(a.phase, b.phase)).toBeGreaterThanOrEqual(SEP - 1e-9)
}

describe('placeMoons', () => {
  it('spreads moons across the allowed orbits before doubling up', () => {
    const slots = placeMoons(ids(5), new Map(), 3, sep)
    expect(ids(5).map((id) => slots.get(id)!.orbit)).toEqual([0, 1, 2, 0, 1])
  })

  it('puts a second moon opposite the first on its orbit', () => {
    const slots = placeMoons(ids(4), new Map(), 3, sep)
    expect(gap(slots.get('a0')!.phase, slots.get('a3')!.phase)).toBeCloseTo(Math.PI)
  })

  it('never puts two moons on one orbit closer than the separation', () => {
    assertApart(placeMoons(ids(40), new Map(), 3, sep))
  })

  it('opens an orbit past the limit only when the allowed ones are full', () => {
    // 2π / 0.5 leaves room for 12 evenly; the widest-gap rule fits 8 per orbit.
    const slots = placeMoons(ids(20), new Map(), 2, sep)
    const orbits = [...slots.values()].map((s) => s.orbit)
    expect(orbits.filter((o) => o < 2).length).toBe(16)
    expect(Math.max(...orbits)).toBe(2)
  })

  it('moves no moon when one arrives or leaves', () => {
    const first = placeMoons(ids(6), new Map(), 3, sep)
    const after = placeMoons(['a0', 'a2', 'a3', 'a5', 'new'], first, 3, sep)
    for (const id of ['a0', 'a2', 'a3', 'a5']) expect(after.get(id)).toEqual(first.get(id))
    // The orbits a1 and a4 left are the emptiest; the newcomer takes the inner one.
    expect(after.get('new')!.orbit).toBe(1)
    assertApart(after)
  })

  it('keeps a moon past the limit in place while the limit stays', () => {
    const first = placeMoons(ids(20), new Map(), 2, sep)
    const overflow = ids(20).filter((id) => first.get(id)!.orbit === 2)
    const after = placeMoons(ids(20).filter((id) => id !== 'a0' && id !== overflow[0]), first, 2, sep)
    for (const id of overflow.slice(1)) expect(after.get(id)).toEqual(first.get(id))
  })

  it('places again only the moons a lowered limit leaves outside', () => {
    const first = placeMoons(ids(5), new Map(), 5, sep)
    const lowered = placeMoons(ids(5), first, 2, sep)
    for (const id of ['a0', 'a1']) {
      expect(lowered.get(id)!.orbit).toBe(first.get(id)!.orbit)
      expect(lowered.get(id)!.phase).toBe(first.get(id)!.phase)
    }
    expect([...lowered.values()].every((s) => s.orbit < 2)).toBe(true)
    assertApart(lowered)
  })

  it('places again a kept moon a wider separation puts too close', () => {
    const first = placeMoons(ids(12), new Map(), 1, sep)
    const wider = placeMoons(ids(12), first, 1, () => 1)
    const all = [...wider.values()]
    for (const a of all)
      for (const b of all) if (a !== b && a.orbit === b.orbit) expect(gap(a.phase, b.phase)).toBeGreaterThanOrEqual(1 - 1e-9)
  })
})
