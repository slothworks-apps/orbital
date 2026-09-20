import { describe, it, expect } from 'vitest'
import {
  createSimulation,
  reconcileSimulation,
  stepSimulation,
  settleSimulation,
  dragSimBody,
  holeDropState,
  minDistance,
  rehomeTarget,
  separation,
  HOLE_CAPTURE_RADIUS,
  HOLE_DROP_RADIUS,
  HOLE_REPEL_RADIUS,
  SAME_TAG_GAP,
  SEPARATION_SAME,
  CROSS_TAG_GAP,
  type SimInput,
  type SimState,
} from '../map/simulation'

/**
 * The spring simulation is pure and deterministic: no Math.random, no
 * Date.now — every test here drives fixed 60Hz ticks by hand and asserts on
 * plain numbers. This is the contract that keeps the physics unit-testable
 * in jsdom (spec 2026-09-18-tag-clusters-design § 1).
 */

const TICK = 1 / 60

function makeInput(overrides: Partial<SimInput> = {}): SimInput {
  return {
    bodies: [
      { id: 'a1', tagId: 1, x: -4, y: 0, r: 1, live: true, released: false },
      { id: 'a2', tagId: 1, x: -3, y: 1.2, r: 0.71, live: false, released: false },
      { id: 'a3', tagId: 1, x: -5, y: -1, r: 0.44, live: false, released: false },
      { id: 'b1', tagId: 2, x: 5, y: 0.5, r: 1, live: true, released: false },
      { id: 'b2', tagId: 2, x: 4, y: -1, r: 0.71, live: false, released: false },
    ],
    anchors: [
      { tagId: 1, x: -4, y: 0 },
      { tagId: 2, x: 4.5, y: 0 },
    ],
    hole: { x: 30, y: -30 },
    ...overrides,
  }
}

function makeSim(input: SimInput = makeInput()): SimState {
  const sim = createSimulation()
  reconcileSimulation(sim, input)
  return sim
}

function step(sim: SimState, ticks: number) {
  const absorbed: string[] = []
  for (let i = 0; i < ticks; i++) absorbed.push(...stepSimulation(sim, TICK).absorbed)
  return absorbed
}

function body(sim: SimState, id: string) {
  const b = sim.bodies.get(id)
  if (!b) throw new Error(`no body ${id}`)
  return b
}

describe('reconcileSimulation', () => {
  it('seeds a new body at its input position, awake and holding', () => {
    const sim = makeSim()
    const a1 = body(sim, 'a1')
    expect({ x: a1.x, y: a1.y }).toEqual({ x: -4, y: 0 })
    expect(a1.mode).toBe('hold')
    expect(a1.asleep).toBe(false)
  })

  it('removes bodies that left the model and keeps the survivors where they stood', () => {
    const sim = makeSim()
    step(sim, 30)
    const before = { x: body(sim, 'a1').x, y: body(sim, 'a1').y }
    const input = makeInput()
    input.bodies = input.bodies.filter((b) => b.id !== 'b2')
    reconcileSimulation(sim, input)
    expect(sim.bodies.has('b2')).toBe(false)
    expect({ x: body(sim, 'a1').x, y: body(sim, 'a1').y }).toEqual(before)
  })

  it('a retag keeps the body in place — the springs walk it over, it never cuts', () => {
    const sim = makeSim()
    settleSimulation(sim)
    const before = { x: body(sim, 'a2').x, y: body(sim, 'a2').y }
    const input = makeInput()
    input.bodies = input.bodies.map((b) => (b.id === 'a2' ? { ...b, tagId: 2 } : b))
    reconcileSimulation(sim, input)
    expect({ x: body(sim, 'a2').x, y: body(sim, 'a2').y }).toEqual(before)
    expect(body(sim, 'a2').asleep).toBe(false)

    // …and over time it walks toward its new tag's anchor.
    const distBefore = Math.hypot(body(sim, 'a2').x - 4.5, body(sim, 'a2').y - 0)
    step(sim, 600)
    const distAfter = Math.hypot(body(sim, 'a2').x - 4.5, body(sim, 'a2').y - 0)
    expect(distAfter).toBeLessThan(distBefore)
  })
})

describe('stepSimulation', () => {
  it('is deterministic: same input, same ticks, bit-identical state', () => {
    const simA = makeSim()
    const simB = makeSim()
    step(simA, 300)
    step(simB, 300)
    for (const [id, a] of simA.bodies) {
      const b = body(simB, id)
      expect(b.x).toBe(a.x)
      expect(b.y).toBe(a.y)
      expect(b.vx).toBe(a.vx)
      expect(b.vy).toBe(a.vy)
    }
  })

  it('settles to rest: every body ends asleep and stays put', () => {
    const sim = makeSim()
    let ticks = 0
    while (ticks < 3600 && [...sim.bodies.values()].some((b) => !b.asleep)) {
      step(sim, 1)
      ticks++
    }
    expect(ticks).toBeLessThan(3600)
    const rested = [...sim.bodies.values()].map((b) => ({ x: b.x, y: b.y }))
    step(sim, 60)
    const after = [...sim.bodies.values()].map((b) => ({ x: b.x, y: b.y }))
    expect(after).toEqual(rested)
  })

  it('keeps bodies from overlapping, and rests cross-tag pairs farther apart than same-tag pairs', () => {
    const sim = makeSim()
    settleSimulation(sim)
    const bodies = [...sim.bodies.values()]
    let sameMin = Infinity
    let crossMin = Infinity
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]
        const b = bodies[j]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        expect(d).toBeGreaterThan(a.r + b.r)
        if (a.tagId === b.tagId) sameMin = Math.min(sameMin, d)
        else crossMin = Math.min(crossMin, d)
      }
    }
    expect(crossMin).toBeGreaterThan(sameMin)
    // The two gaps the canvas footer names, as constants callers can read.
    expect(CROSS_TAG_GAP).toBeGreaterThan(SAME_TAG_GAP)
  })

  it('a dragged body pins to the pointer and its tag-mates trail after it', () => {
    const sim = makeSim()
    settleSimulation(sim)
    const mateBefore = { x: body(sim, 'a2').x, y: body(sim, 'a2').y }

    dragSimBody(sim, 'a1', { x: -4, y: 10 })
    step(sim, 1)
    expect(body(sim, 'a1').x).toBe(-4)
    expect(body(sim, 'a1').y).toBe(10)

    // The barycentre moved with the dragged body, so the clump follows.
    step(sim, 300)
    const mateAfter = body(sim, 'a2')
    expect(mateAfter.y).toBeGreaterThan(mateBefore.y + 0.5)

    dragSimBody(sim, 'a1', null)
    expect(body(sim, 'a1').drag).toBeNull()
    void mateBefore
  })

  it('repels a bonded body out of the hole halo instead of letting it rest there', () => {
    const input = makeInput()
    // Park a lone live body just inside the halo.
    input.bodies = [{ id: 'x', tagId: 1, x: 26, y: -26, r: 1, live: true, released: false }]
    input.anchors = [{ tagId: 1, x: 24, y: -24 }]
    const sim = makeSim(input)
    const distBefore = Math.hypot(body(sim, 'x').x - 30, body(sim, 'x').y + 30)
    step(sim, 240)
    const distAfter = Math.hypot(body(sim, 'x').x - 30, body(sim, 'x').y + 30)
    expect(distAfter).toBeGreaterThan(distBefore)
  })

  it('a released body falls to the hole and reports its absorption exactly once', () => {
    const input = makeInput()
    input.bodies = input.bodies.map((b) => (b.id === 'a3' ? { ...b, released: true } : b))
    const sim = makeSim(input)
    expect(body(sim, 'a3').mode).toBe('fall')

    const absorbed = step(sim, 60 * 30) // up to 30s of fall
    expect(absorbed).toEqual(['a3'])
    expect(body(sim, 'a3').mode).toBe('gone')
    // Falling bodies never disturb the others' barycentre: the rest are still bonded.
    expect(body(sim, 'a1').mode).toBe('hold')
  })

  it('an undo re-bonds a falling body and the springs pull it home again', () => {
    const input = makeInput()
    input.bodies = input.bodies.map((b) => (b.id === 'a3' ? { ...b, released: true } : b))
    const sim = makeSim(input)
    step(sim, 240) // partway into the fall
    const fallen = body(sim, 'a3')
    expect(fallen.mode).toBe('fall')
    const distToAnchor = Math.hypot(fallen.x - -4, fallen.y - 0)

    reconcileSimulation(sim, makeInput()) // released: false again
    expect(body(sim, 'a3').mode).toBe('hold')
    step(sim, 600)
    const back = body(sim, 'a3')
    expect(Math.hypot(back.x - -4, back.y - 0)).toBeLessThan(distToAnchor)
  })
})

describe('settleSimulation', () => {
  it('resolves falls instantly and puts every bonded body to sleep (reduced motion)', () => {
    const input = makeInput()
    input.bodies = input.bodies.map((b) => (b.id === 'a3' ? { ...b, released: true } : b))
    const sim = makeSim(input)
    settleSimulation(sim)
    expect(body(sim, 'a3').mode).toBe('gone')
    for (const b of sim.bodies.values()) {
      if (b.mode === 'hold') expect(b.asleep).toBe(true)
    }
  })
})

describe('fall visuals', () => {
  it('stretches along the path and shrinks toward the horizon as it closes in', () => {
    const input = makeInput()
    input.bodies = [
      { id: 'f', tagId: 1, x: 22, y: -22, r: 0.44, live: false, released: true },
    ]
    input.anchors = [{ tagId: 1, x: -4, y: 0 }]
    const sim = makeSim(input)
    let sawStretch = false
    let sawShrink = false
    for (let i = 0; i < 60 * 30 && body(sim, 'f').mode === 'fall'; i++) {
      step(sim, 1)
      const f = body(sim, 'f')
      if (f.fallStretch > 1.05) sawStretch = true
      if (f.fallScale < 0.95) sawShrink = true
    }
    expect(body(sim, 'f').mode).toBe('gone')
    expect(sawStretch).toBe(true)
    expect(sawShrink).toBe(true)
    expect(HOLE_CAPTURE_RADIUS).toBeGreaterThan(0)
  })
})

describe('holeDropState', () => {
  // Hole at (30,-30) — see makeInput. 'a2' is idle (absorbable), 'a1' is live.
  function simWithDrag(id: string, x: number, y: number): SimState {
    const sim = makeSim()
    dragSimBody(sim, id, { x, y })
    stepSimulation(sim, TICK) // the drag pin is applied on the next tick
    return sim
  }

  it('is none with no drag, and none for a body that is not actually dragging', () => {
    const sim = makeSim()
    expect(holeDropState(sim, null, 1)).toBe('none')
    expect(holeDropState(sim, 'a2', 1)).toBe('none')
    expect(holeDropState(sim, 'unknown', 1)).toBe('none')
  })

  it('is eligible while an absorbable body is dragged anywhere outside the halo', () => {
    const sim = simWithDrag('a2', -10, 5)
    expect(holeDropState(sim, 'a2', 1)).toBe('eligible')
  })

  it('arms inside the drop halo — release there absorbs', () => {
    const sim = simWithDrag('a2', 30 - HOLE_DROP_RADIUS / 2, -30)
    expect(holeDropState(sim, 'a2', 1)).toBe('armed')
  })

  it('never offers the hole to a live body, even inside the halo', () => {
    const sim = simWithDrag('a1', 30, -30)
    expect(holeDropState(sim, 'a1', 1)).toBe('none')
  })

  it('follows the counter-zoomed halo: a drop just outside the base radius arms when the factor inflates it', () => {
    const d = HOLE_DROP_RADIUS * 1.2
    const sim = simWithDrag('a2', 30 - d, -30)
    expect(holeDropState(sim, 'a2', 1)).toBe('eligible')
    expect(holeDropState(sim, 'a2', 1.5)).toBe('armed')
  })
})

// Tag clusters follow-up (agreed in chat): a drop re-homes the clump — the
// tag's anchor moves to where the body was released — EXCEPT when the drop
// absorbs the body (the survivors keep their old home) or lands inside the
// hole's repulsion halo (a home the physics fights forever is no home).
describe('rehomeTarget', () => {
  function simWithDrag(id: string, x: number, y: number): SimState {
    const sim = makeSim()
    dragSimBody(sim, id, { x, y })
    stepSimulation(sim, TICK)
    return sim
  }

  it('returns the drop position and the tag for an ordinary release, live bodies included', () => {
    expect(rehomeTarget(simWithDrag('a2', -10, 5), 'a2', 1)).toEqual({ tagId: 1, x: -10, y: 5 })
    expect(rehomeTarget(simWithDrag('a1', 8, 8), 'a1', 1)).toEqual({ tagId: 1, x: 8, y: 8 })
  })

  it('returns null when the release absorbs the body — the survivors keep their old home', () => {
    const sim = simWithDrag('a2', 30 - HOLE_DROP_RADIUS / 2, -30)
    expect(holeDropState(sim, 'a2', 1)).toBe('armed')
    expect(rehomeTarget(sim, 'a2', 1)).toBeNull()
  })

  it('returns null inside the repulsion halo, where a home would fight the physics', () => {
    const nearHole = HOLE_REPEL_RADIUS * 0.8
    const sim = simWithDrag('a1', 30 - nearHole, -30)
    expect(rehomeTarget(sim, 'a1', 1)).toBeNull()
  })

  it('returns null with no active drag', () => {
    const sim = makeSim()
    expect(rehomeTarget(sim, null, 1)).toBeNull()
    expect(rehomeTarget(sim, 'a2', 1)).toBeNull()
  })
})

// A planet's `r` is its FOOTPRINT — its own radius, or its outermost moon
// shell when the moon system reaches further — so spawning subagents has to
// make room rather than grow moons through the neighbours.
describe('footprints and separation', () => {
  /** Two same-tag bodies either side of a shared anchor, nothing else on the map. */
  function pair(r: number): SimState {
    const sim = createSimulation()
    reconcileSimulation(sim, {
      bodies: [
        { id: 'p1', tagId: 1, x: -1, y: 0, r, live: true, released: false },
        { id: 'p2', tagId: 1, x: 1, y: 0, r, live: true, released: false },
      ],
      anchors: [{ tagId: 1, x: 0, y: 0 }],
      hole: { x: 100, y: -100 },
    })
    return sim
  }

  function spread(sim: SimState, zoomFactor = 1): number {
    settleSimulation(sim, zoomFactor)
    return Math.hypot(body(sim, 'p1').x - body(sim, 'p2').x, body(sim, 'p1').y - body(sim, 'p2').y)
  }

  it('measures the clearance from the footprints, leaving the canvas gap alone', () => {
    expect(minDistance(1, 1, true)).toBeCloseTo(2 + SAME_TAG_GAP, 10)
    expect(minDistance(1, 1, false)).toBeCloseTo(2 + CROSS_TAG_GAP, 10)
    // Zooming out inflates the drawn bodies, so it inflates what they are
    // kept clear of — but never the empty space the canvas specifies.
    expect(minDistance(1, 1, true, 1.7)).toBeCloseTo(3.4 + SAME_TAG_GAP, 10)
  })

  it('settles bigger footprints further apart, never inside one another', () => {
    const small = spread(pair(1))
    const withMoons = spread(pair(2.04))
    const many = spread(pair(3))

    expect(withMoons).toBeGreaterThan(small)
    expect(many).toBeGreaterThan(withMoons)
    // The real requirement: the two systems never share space.
    expect(withMoons).toBeGreaterThan(2 * 2.04)
    expect(many).toBeGreaterThan(2 * 3)
  })

  it('keeps them clear at far zoom too, where every body is drawn inflated', () => {
    // A planet carrying three moons, at the counter-zoom factor's cap.
    const zoomFactor = 1.7
    const r = 2.04
    expect(spread(pair(r), zoomFactor)).toBeGreaterThan(2 * r * zoomFactor)
  })

  it('widens the clump as the camera zooms out and closes it again on the way back', () => {
    const near = spread(pair(1), 1)
    const far = spread(pair(1), 1.7)
    expect(far).toBeGreaterThan(near)
  })

  it('wakes a settled clump when a body grows a moon, so the springs walk it open', () => {
    const sim = pair(1)
    settleSimulation(sim)
    expect([...sim.bodies.values()].every((b) => b.asleep)).toBe(true)
    const before = Math.hypot(body(sim, 'p1').x - body(sim, 'p2').x, 0)

    reconcileSimulation(sim, {
      bodies: [
        { id: 'p1', tagId: 1, x: -1, y: 0, r: 2.04, live: true, released: false },
        { id: 'p2', tagId: 1, x: 1, y: 0, r: 1, live: true, released: false },
      ],
      anchors: [{ tagId: 1, x: 0, y: 0 }],
      hole: { x: 100, y: -100 },
    })
    expect([...sim.bodies.values()].some((b) => b.asleep)).toBe(false)

    // …and it opens gradually rather than jumping: one tick moves it a
    // little, the settle moves it the rest of the way.
    step(sim, 1)
    const afterOneTick = Math.hypot(body(sim, 'p1').x - body(sim, 'p2').x, 0)
    expect(afterOneTick).toBeGreaterThan(before)
    expect(afterOneTick - before).toBeLessThan(0.1)

    settleSimulation(sim)
    const settled = Math.hypot(body(sim, 'p1').x - body(sim, 'p2').x, 0)
    expect(settled).toBeGreaterThan(afterOneTick)
    expect(settled).toBeGreaterThan(2.04 + 1)
  })
})

// The separation ramp: proportional to the pair's size, where the canvas
// script's was independent of it — a clump must not close over a planet's
// moons just because that planet got bigger.
describe('separation', () => {
  const REFERENCE_MIN = minDistance(1, 1, true)

  it('reproduces the canvas script exactly at the pair it was tuned on', () => {
    for (const d of [1, 2, 3, 4, 4.8]) {
      expect(separation(REFERENCE_MIN, d, true)).toBeCloseTo(
        ((REFERENCE_MIN - d) / REFERENCE_MIN) * SEPARATION_SAME,
        12
      )
    }
  })

  it('pushes harder the larger the pair, at the point where the two bodies touch', () => {
    const atTouch = (r: number) => {
      const min = minDistance(r, r, true)
      return separation(min, min - SAME_TAG_GAP, true)
    }
    expect(atTouch(2.04)).toBeGreaterThan(atTouch(1))
    expect(atTouch(3)).toBeGreaterThan(atTouch(2.04))
  })

  it('never pushes at or beyond the minimum distance, and stays bounded inside it', () => {
    const min = minDistance(3, 3, true)
    expect(separation(min, min, true)).toBe(0)
    expect(separation(min, 0, true)).toBe(separation(min, min - REFERENCE_MIN, true))
  })
})
