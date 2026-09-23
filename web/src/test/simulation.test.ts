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
  CROSS_TAG_EXTRA,
  NEIGHBOUR_AIR_PX,
  bodyExtent,
  holeLabelBox,
  planetOutline,
  type Extent,
  type PlanetOutline,
  type SimInput,
  type SimState,
} from '../map/simulation'
import {
  ACTIVE_SCALE,
  ENDED_SCALE,
  GOLDEN_ANGLE,
  IDLE_SCALE,
  MIN_GAP,
  SPIRAL_SAFETY_MARGIN,
} from '../map/layout'
import { REFERENCE_ZOOM, bodyZoomFactor } from '../map/camera'
import {
  BADGE_OFFSET_X,
  BADGE_OFFSET_Y,
  BRACKET_INSET,
  HOLE_LABEL_GAP,
  HOLE_RADIUS,
  holeLabelSizePx,
  LABEL_SELECTED_REST_Y,
  LABEL_TOP_REST_Y,
  labelRestY,
  labelFontPx,
  moonVisuals,
  restingLabelSizePx,
  statePillSizePx,
} from '../map/visuals'
import { moonOrbitRadius } from '../map/sceneModel'
import { statePill, type ApiSession, type SessionStatus } from '../lib/types'

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
    expect(CROSS_TAG_EXTRA).toBeGreaterThan(0)
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

  function spread(sim: SimState, zoom = REFERENCE_ZOOM): number {
    settleSimulation(sim, zoom)
    return Math.hypot(body(sim, 'p1').x - body(sim, 'p2').x, body(sim, 'p1').y - body(sim, 'p2').y)
  }

  it('keeps the two boxes plus the air apart, and a different tag further still', () => {
    const air = NEIGHBOUR_AIR_PX / REFERENCE_ZOOM
    expect(minDistance(square(3), square(3), 1, 0, true)).toBeCloseTo(6 + air, 10)
    expect(minDistance(square(3), square(3), -1, 0, false)).toBeCloseTo(6 + air + CROSS_TAG_EXTRA, 10)
    // The air is screen px: zoomed out it is more world, zoomed in never less.
    expect(minDistance(square(3), square(3), 1, 0, true, REFERENCE_ZOOM / 2)).toBeCloseTo(6 + 2 * air, 10)
    expect(minDistance(square(3), square(3), 1, 0, true, REFERENCE_ZOOM * 2)).toBeCloseTo(6 + air, 10)
  })

  it('measures along the line between the two, so a corner neighbour sits further off than a side one', () => {
    const air = NEIGHBOUR_AIR_PX / REFERENCE_ZOOM
    const diagonal = minDistance(square(3), square(3), Math.SQRT1_2, Math.SQRT1_2, true)
    expect(diagonal).toBeCloseTo((6 + air) * Math.SQRT2, 10)
  })

  it('roofs the top and bottom faces: straight above is the highest point, and it never cuts into the box', () => {
    // A neighbour above: how high its centre has to sit, as the direction
    // swings from straight up to the box's corner.
    const air = NEIGHBOUR_AIR_PX / REFERENCE_ZOOM
    const face = 6 + air
    let previous = Infinity
    for (let i = 0; i <= 20; i++) {
      const angle = Math.PI / 2 - (i / 20) * (Math.PI / 4)
      const height = minDistance(square(3), square(3), Math.cos(angle), Math.sin(angle), true) * Math.sin(angle)
      expect(height).toBeGreaterThanOrEqual(face - 1e-9)
      expect(height).toBeLessThanOrEqual(previous + 1e-9)
      previous = height
    }
    // Higher than the face straight above, down to it by the corner.
    expect(minDistance(square(3), square(3), 0, 1, true)).toBeGreaterThan(face)
    expect(previous).toBeCloseTo(face, 10)
  })

  it('reads a lopsided box from the side the neighbour is on, the same from either end', () => {
    // A label hanging below `a`: a neighbour straight under it has to clear
    // the label, one straight above only the body.
    const a: Extent = { left: -1, right: 1, bottom: -3, top: 1 }
    const b = square(1)
    // Beside it, the body alone; below, the label's drop more than above.
    const air = NEIGHBOUR_AIR_PX / REFERENCE_ZOOM
    expect(minDistance(a, b, 1, 0, true)).toBeCloseTo(2 + air, 10)
    expect(minDistance(a, b, 0, -1, true) - minDistance(a, b, 0, 1, true)).toBeCloseTo(2, 10)
    // Seen from the neighbour, the direction flips and the distance holds.
    expect(minDistance(b, a, 0, 1, true)).toBeCloseTo(minDistance(a, b, 0, -1, true), 10)
    expect(minDistance(b, a, -0.6, 0.8, true)).toBeCloseTo(minDistance(a, b, 0.6, -0.8, true), 10)
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
    // A planet carrying three moons, zoomed out to where it is drawn well
    // past its world size.
    const r = 2.04
    expect(spread(pair(r), FAR_ZOOM)).toBeGreaterThan(2 * r * bodyZoomFactor(FAR_ZOOM))
  })

  it('widens the clump as the camera zooms out and closes it again on the way back', () => {
    const near = spread(pair(1))
    const far = spread(pair(1), FAR_ZOOM)
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

// The contact: a pair rests where `minDistance` says, not somewhere inside
// it. The canvas script's soft ramp let cohesion press a settled clump to
// 64–81 % of its minimum, which is how labels spaced to clear each other
// still met (ADR separation-rests-at-the-outline).
describe('separation', () => {
  const REFERENCE_MIN = minDistance(square(1), square(1), 1, 0, true)

  it('rests a settled clump within a few percent of every touching pair’s minimum', () => {
    const sim = mixedCluster(REFERENCE_ZOOM)
    const bodies = [...sim.bodies.values()]
    let tightest = Infinity
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]
        const b = bodies[j]
        const d = Math.hypot(b.x - a.x, b.y - a.y)
        const min = minDistance(a.extent, b.extent, (b.x - a.x) / d, (b.y - a.y) / d, true)
        tightest = Math.min(tightest, d / min)
      }
    }
    expect(tightest).toBeGreaterThan(0.95)
  })

  it('stops a collision in one approach, without bouncing back out', () => {
    // Two bodies seeded deep inside each other's minimum: the contact
    // throws them apart, and they must come to rest at it rather than
    // overshoot past it and fall back in.
    const sim = createSimulation()
    reconcileSimulation(sim, {
      bodies: [
        { id: 'p1', tagId: 1, x: -0.5, y: 0, r: 1, live: true, released: false },
        { id: 'p2', tagId: 1, x: 0.5, y: 0, r: 1, live: true, released: false },
      ],
      anchors: [{ tagId: 1, x: 0, y: 0 }],
      hole: { x: 100, y: -100 },
    })
    let widest = 0
    let ticks = 0
    while (ticks < 3600 && [...sim.bodies.values()].some((b) => !b.asleep)) {
      step(sim, 1)
      ticks++
      widest = Math.max(widest, Math.hypot(body(sim, 'p1').x - body(sim, 'p2').x, 0))
    }
    expect(ticks).toBeLessThan(3600)
    expect(widest).toBeLessThan(REFERENCE_MIN * 1.02)
  })

  it('pushes the same overlap equally hard whatever the pair’s size, and harder at full contact the bigger it is', () => {
    const push = (r: number, depth: number) => {
      const min = minDistance(square(r), square(r), 1, 0, true)
      return separation(min, min - depth, true)
    }
    expect(push(2.04, 0.01)).toBeCloseTo(push(1, 0.01), 12)
    expect(push(3, 0.01)).toBeCloseTo(push(1, 0.01), 12)
    expect(push(2.04, 3)).toBeGreaterThan(push(1, 3))
    expect(push(3, 3)).toBeGreaterThan(push(2.04, 3))
  })

  it('never pushes at or beyond the minimum distance, and stays bounded inside it', () => {
    const min = minDistance(square(3), square(3), 1, 0, true)
    expect(separation(min, min, true)).toBe(0)
    expect(separation(min, 0, true)).toBe(separation(min, min / 2, true))
    expect(separation(min, 0, true)).toBeGreaterThan(0)
  })
})

describe('bodyExtent', () => {
  const outline = {
    scale: 1,
    labelTop: -LABEL_TOP_REST_Y,
    labelWidthPx: 180,
    labelHeightPx: 30,
    pillX: BADGE_OFFSET_X,
    pillY: BADGE_OFFSET_Y,
    pillWidthPx: 0,
    pillHeightPx: 0,
  }
  const extent = (r: number, o: PlanetOutline | null, zoom = REFERENCE_ZOOM) => bodyExtent(r, o, zoom, square(0))

  it('is the footprint alone for a bare body, at its counter-zoomed size', () => {
    expect(extent(2, null)).toEqual(square(2))
    const far = extent(2, null, FAR_ZOOM)
    expect(far.right).toBeCloseTo(2 * bodyZoomFactor(FAR_ZOOM), 12)
    expect(far.bottom).toBeCloseTo(-2 * bodyZoomFactor(FAR_ZOOM), 12)
  })

  it('hangs the label below the body and the pill off to the right', () => {
    const plain = extent(0.44, outline)
    expect(plain.left).toBeCloseTo(-90 / REFERENCE_ZOOM, 12)
    expect(plain.right).toBeCloseTo(90 / REFERENCE_ZOOM, 12)
    expect(plain.bottom).toBeCloseTo(LABEL_TOP_REST_Y - 30 / REFERENCE_ZOOM, 12)
    expect(plain.top).toBeCloseTo(BRACKET_INSET, 12)

    const withPill = extent(0.44, { ...outline, pillWidthPx: 200, pillHeightPx: 20 })
    expect(withPill.right).toBeCloseTo(BADGE_OFFSET_X + 200 / REFERENCE_ZOOM, 12)
    expect(withPill.left).toBe(plain.left)

    // A moon system wider than all of it is measured by its moons.
    expect(extent(4, outline)).toEqual(square(4))
  })

  it('never lets a selected planet’s reticle push its neighbours: the brackets always count', () => {
    const bare = extent(0, { ...outline, labelWidthPx: 0, labelHeightPx: 0 })
    expect(bare.right).toBeCloseTo(BRACKET_INSET, 12)
    expect(bare.top).toBeCloseTo(BRACKET_INSET, 12)
  })

  it('grows the label with the whole zoom ratio when zooming out, and holds it when zooming in', () => {
    const half = extent(0.44, outline, REFERENCE_ZOOM / 2)
    // Half the zoom: the label's px are twice the world units, while the
    // body's offset grows only by the counter-zoom.
    expect(half.right).toBeCloseTo((2 * 90) / REFERENCE_ZOOM, 12)
    expect(half.bottom).toBeCloseTo(
      LABEL_TOP_REST_Y * bodyZoomFactor(REFERENCE_ZOOM / 2) - (2 * 30) / REFERENCE_ZOOM,
      12
    )
    expect(extent(0.44, outline, REFERENCE_ZOOM * 3)).toEqual(extent(0.44, outline))
  })
})


// The acceptance check: in ordinary settled clusters, nothing a planet draws
// below or beside it — its label, its pill — touches anything a neighbour
// draws. Measured with rectangles built straight from the drawing constants
// (not from `bodyExtent`), at the default zoom and at the zooms a
// fit of a few clusters lands on.
describe('settled clusters keep labels and pills clear', () => {
  const AIR_PX = 8

  function rects(sim: SimState, zoom: number, specs: ClusterSpec[]) {
    const out: Array<{ id: string; kind: string; x0: number; x1: number; y0: number; y1: number }> = []
    const perPx = 1 / zoom
    const zf = bodyZoomFactor(zoom)
    for (const spec of specs) {
      const b = body(sim, spec.id)
      const s = scaleFor(spec.status) * zf
      // Body, halo, tick ring and the selection brackets all sit inside this square.
      const edge = BRACKET_INSET * s
      out.push({ id: spec.id, kind: 'body', x0: b.x - edge, x1: b.x + edge, y0: b.y - edge, y1: b.y + edge })
      const label = restingLabelSizePx(spec.title, 'OPUS', FONT)
      // A selected planet hangs its label under the reticle's brackets instead.
      const top = b.y + (spec.selected ? LABEL_SELECTED_REST_Y : LABEL_TOP_REST_Y) * s
      out.push({
        id: spec.id,
        kind: 'label',
        x0: b.x - (label.width / 2) * perPx,
        x1: b.x + (label.width / 2) * perPx,
        y0: top - label.height * perPx,
        y1: top,
      })
      const pill = statePill(session(spec))
      if (pill) {
        const size = statePillSizePx(pill.label, pill.pulse)
        const x = b.x + BADGE_OFFSET_X * s
        const y = b.y + BADGE_OFFSET_Y * s
        out.push({ id: spec.id, kind: pill.label, x0: x, x1: x + size.width * perPx, y0: y - size.height * perPx, y1: y })
      }
    }
    return out
  }

  for (const [name, specs] of Object.entries(CLUSTERS)) {
    for (const zoom of [REFERENCE_ZOOM, 40, 26, 20]) {
      it(`${name}, zoom ${zoom}`, () => {
        const sim = settledCluster(specs, zoom)
        const drawn = rects(sim, zoom, specs)
        const touching: string[] = []
        for (const a of drawn) {
          if (a.kind === 'body') continue
          for (const b of drawn) {
            if (b.id === a.id) continue
            const gapPx = Math.max(a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1) * zoom
            if (gapPx < AIR_PX) touching.push(`${a.id} ${a.kind} / ${b.id} ${b.kind}: ${gapPx.toFixed(1)}px`)
          }
        }
        expect(touching).toEqual([])
      })
    }
  }
})

// Selecting a planet moves nothing: the outline already keeps room for the
// label where it hangs under the reticle's brackets, selected or not.
describe('selection moves nothing', () => {
  it('measures the label where it hangs while selected, gauged or not, whether or not it is', () => {
    const spec: ClusterSpec = { id: 'p', status: 'working', title: LONG }
    for (const gauged of [false, true]) {
      const planet = { session: session(spec), scale: ACTIVE_SCALE, modelFamily: 'Opus', gauged }
      const plain = planetOutline({ ...planet, selected: false } as typeof planet, 1, FONT)
      const selected = planetOutline({ ...planet, selected: true } as typeof planet, 1, FONT)
      expect(selected).toEqual(plain)

      // The box reaches down past the dropped label's bottom edge.
      const e = bodyExtent(ACTIVE_SCALE, plain, REFERENCE_ZOOM, square(0))
      const label = restingLabelSizePx(LONG, 'OPUS', FONT)
      const droppedBottom = labelRestY(gauged, true) * ACTIVE_SCALE - label.height / REFERENCE_ZOOM
      expect(e.bottom).toBeLessThanOrEqual(droppedBottom + 1e-12)
    }
  })

  it('selecting a planet in a settled cluster moves no neighbour', () => {
    const specs = CLUSTERS['three, two of them DONE']
    const sim = settledCluster(specs, REFERENCE_ZOOM)
    const before = [...sim.bodies.values()].map((b) => ({ id: b.id, x: b.x, y: b.y }))

    // The map re-reconciles when the selection changes; nothing wakes.
    reconcileSimulation(sim, clusterInput(specs.map((s) => ({ ...s, selected: s.id === 'b' }))))
    expect([...sim.bodies.values()].every((b) => b.asleep)).toBe(true)
    step(sim, 120)
    for (const was of before) {
      const now = body(sim, was.id)
      expect(Math.hypot(now.x - was.x, now.y - was.y)).toBeLessThan(1e-6)
    }
  })
})

// A planet's box is much wider than it is tall, so pushed square off the
// face two boxes meet at, a clump was only ever pushed up and down; cohesion
// drew every x onto the barycentre and three planets settled as a column,
// one exactly under the next (ADR separation-rests-at-the-outline, the later
// 2026-09-23 amendment). A settled cluster keeps a clump's shape instead.
describe('settled clusters keep a clump’s shape, not a column', () => {
  /** Two centres closer in x than this fraction of the smaller body's radius stand one under the other. */
  const SAME_X = 0.25

  function sharesX(a: { x: number; r: number }, b: { x: number; r: number }): boolean {
    return Math.abs(a.x - b.x) < SAME_X * Math.min(a.r, b.r)
  }

  for (const [name, specs] of Object.entries(CLUSTERS)) {
    for (const zoom of [REFERENCE_ZOOM, 40, 26, 20]) {
      it(`${name}, zoom ${zoom}`, () => {
        const sim = settledCluster(specs, zoom)
        const bodies = [...sim.bodies.values()]
        // Settled inside settleSimulation's budget, not cut off by it.
        expect(bodies.every((b) => b.asleep)).toBe(true)

        const xs = bodies.map((b) => b.x)
        const ys = bodies.map((b) => b.y)
        const aspect = (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys))
        expect(aspect).toBeGreaterThan(0.5)
        expect(aspect).toBeLessThan(2)

        const stacked: string[] = []
        for (let i = 0; i < bodies.length; i++) {
          for (let j = i + 1; j < bodies.length; j++) {
            if (!sharesX(bodies[i], bodies[j])) continue
            // Three planets: no two of them one under the other. Larger
            // clumps pack in rows, and a planet can be wedged over one in
            // the row below; what they must not do is stand three high.
            if (bodies.length === 3) stacked.push(`${bodies[i].id}/${bodies[j].id}`)
            for (let k = j + 1; k < bodies.length; k++) {
              if (sharesX(bodies[i], bodies[k]) && sharesX(bodies[j], bodies[k])) {
                stacked.push(`${bodies[i].id}/${bodies[j].id}/${bodies[k].id}`)
              }
            }
          }
        }
        expect(stacked).toEqual([])
      })
    }
  }
})

// The hole's label column reaches well left of its round repulsion halo
// when the map is zoomed out, and a planet used to settle right across
// "HISTORY · N sessions". Bonded bodies keep off the column as they keep
// off a neighbour's label.
describe('the hole keeps bodies off its label', () => {
  const HOLE = { x: 30, y: -30 }
  const COUNT = 499

  /** The label column as `Hole` draws it, in world coordinates, straight from its drawing constants. */
  function drawnLabel(zoom: number) {
    const size = holeLabelSizePx(COUNT)
    const right = HOLE.x - (HOLE_RADIUS + HOLE_LABEL_GAP) * bodyZoomFactor(zoom)
    return {
      x0: right - size.width / zoom,
      x1: right,
      y0: HOLE.y - size.height / 2 / zoom,
      y1: HOLE.y + size.height / 2 / zoom,
    }
  }

  function released(zoom: number, at: { x: number; y: number }): SimState {
    const spec: ClusterSpec = { id: 'p', status: 'working', title: LONG }
    const sim = createSimulation()
    reconcileSimulation(sim, {
      bodies: [
        {
          id: 'p',
          tagId: 1,
          x: at.x,
          y: at.y,
          r: ACTIVE_SCALE,
          outline: planetOutline(
            { session: session(spec), scale: ACTIVE_SCALE, modelFamily: 'Opus', gauged: false },
            1,
            FONT
          ),
          live: true,
          released: false,
        },
      ],
      // Its home is where it was let go, on the label: the spring keeps
      // pressing it back in, so only the label's push keeps it out.
      anchors: [{ tagId: 1, x: at.x, y: at.y }],
      hole: { ...HOLE, label: holeLabelSizePx(COUNT) },
    })
    settleSimulation(sim, zoom)
    return sim
  }

  for (const zoom of [REFERENCE_ZOOM, 26, 20]) {
    for (const [where, along] of [
      ['near the hole', 0.8],
      ['at the far end', 0.15],
    ] as const) {
      it(`a body let go on the label ${where}, zoom ${zoom}, settles clear of it`, () => {
        const label = drawnLabel(zoom)
        const sim = released(zoom, { x: label.x0 + along * (label.x1 - label.x0), y: HOLE.y + 0.1 })
        const p = body(sim, 'p')
        expect(p.asleep).toBe(true)
        const e = bodyExtent(p.r, p.outline, zoom, square(0))
        const gapPx =
          Math.max(label.x0 - (p.x + e.right), p.x + e.left - label.x1, label.y0 - (p.y + e.top), p.y + e.bottom - label.y1) *
          zoom
        expect(gapPx).toBeGreaterThan(0)
      })
    }
  }

  it('measures the column where Hole draws it, and grows it with the zoom ratio as the map zooms out', () => {
    const hole = { ...HOLE, labelWidthPx: 200, labelHeightPx: 40 }
    const at = (zoom: number) => holeLabelBox(hole, zoom, square(0))!
    const near = at(REFERENCE_ZOOM)
    expect(near.right).toBeCloseTo(HOLE.x - (HOLE_RADIUS + HOLE_LABEL_GAP), 12)
    expect(near.right - near.left).toBeCloseTo(200 / REFERENCE_ZOOM, 12)
    expect((near.top + near.bottom) / 2).toBeCloseTo(HOLE.y, 12)
    const far = at(REFERENCE_ZOOM / 2)
    expect(far.right - far.left).toBeCloseTo((2 * 200) / REFERENCE_ZOOM, 12)
    expect(far.right).toBeLessThan(near.right)
    expect(holeLabelBox({ ...hole, labelWidthPx: 0 }, REFERENCE_ZOOM, square(0))).toBeNull()
  })
})

// --- Cluster fixtures ---------------------------------------------------------

interface ClusterSpec {
  id: string
  status: SessionStatus
  title: string
  /** A pending decision: NEEDS INPUT rather than DONE. */
  asks?: boolean
  /** Live moons, all still working — the planet waits on them. */
  moons?: number
  /** Selected: the label drops below the reticle's brackets. */
  selected?: boolean
}

const FONT = labelFontPx(1, false)
/** Zoomed out far enough that the counter-zoom inflates bodies well past their world size. */
const FAR_ZOOM = REFERENCE_ZOOM / 3
const LONG = 'Refactor the session index for speed'

/** The shapes the map shows most: a handful of planets in a tag, mixed tiers, some parked, one with moons. */
const CLUSTERS: Record<string, ClusterSpec[]> = {
  'three, two of them DONE': [
    { id: 'a', status: 'working', title: LONG },
    { id: 'b', status: 'needs_input', title: LONG },
    { id: 'c', status: 'needs_input', title: LONG },
  ],
  'four mixed tiers, one asking': [
    { id: 'a', status: 'working', title: LONG },
    { id: 'b', status: 'needs_input', title: LONG, asks: true },
    { id: 'c', status: 'idle', title: 'Fix login' },
    { id: 'd', status: 'ended', title: LONG },
  ],
  'six mixed tiers with moons': [
    { id: 'a', status: 'working', title: LONG, moons: 3 },
    { id: 'b', status: 'needs_input', title: LONG, asks: true },
    { id: 'c', status: 'working', title: 'Docs pass', moons: 1 },
    { id: 'd', status: 'idle', title: LONG },
    { id: 'e', status: 'ended', title: LONG },
    { id: 'f', status: 'ended', title: 'Spike' },
  ],
  // The selected planet's label hangs lower than a resting one, so the
  // neighbour below it has to keep clear of the dropped label.
  'three, the working one selected': [
    { id: 'a', status: 'working', title: LONG, selected: true },
    { id: 'b', status: 'needs_input', title: LONG },
    { id: 'c', status: 'needs_input', title: LONG },
  ],
  'six with moons, a DONE one selected': [
    { id: 'a', status: 'working', title: LONG, moons: 3 },
    { id: 'b', status: 'needs_input', title: LONG, asks: true },
    { id: 'c', status: 'working', title: 'Docs pass', moons: 1 },
    { id: 'd', status: 'idle', title: LONG },
    { id: 'e', status: 'needs_input', title: LONG, selected: true },
    { id: 'f', status: 'ended', title: 'Spike' },
  ],
}

function scaleFor(status: SessionStatus): number {
  return status === 'ended' ? ENDED_SCALE : status === 'idle' ? IDLE_SCALE : ACTIVE_SCALE
}

function session(spec: ClusterSpec) {
  const moons = spec.moons ?? 0
  return {
    title: spec.title,
    status: spec.status,
    interruptedAt: null,
    pendingDecision: spec.asks ? ({ kind: 'permission' } as unknown as ApiSession['pendingDecision']) : null,
    awaitingSubagents: moons > 0,
    subagents: Array.from({ length: moons }, (_, i) => ({
      id: `${spec.id}-moon${i}`,
      name: 'moon',
      state: 'working' as const,
      startedAt: 0,
    })),
  } as unknown as ApiSession
}

/**
 * A same-tag cluster seeded on the layout's golden-angle spiral, as the
 * scene model seeds one, and settled at `zoom`. A planet with moons is
 * measured by its moon shell, as `buildSceneModel` measures it.
 */
function settledCluster(specs: ClusterSpec[], zoom: number): SimState {
  const sim = createSimulation()
  reconcileSimulation(sim, clusterInput(specs))
  settleSimulation(sim, zoom)
  return sim
}

/**
 * The sim input for a cluster, built the way `SpaceMap` builds it: the
 * outline from the scene planet as a whole, `selected` flag and all.
 */
function clusterInput(specs: ClusterSpec[]): SimInput {
  const k = 2 * ACTIVE_SCALE + MIN_GAP + SPIRAL_SAFETY_MARGIN
  return {
    bodies: specs.map((spec, i) => {
      const scale = scaleFor(spec.status)
      const moons = spec.moons ?? 0
      const planet = {
        session: session(spec),
        scale,
        modelFamily: 'Opus',
        gauged: false,
        selected: spec.selected ?? false,
      }
      return {
        id: spec.id,
        tagId: 1,
        x: k * Math.sqrt(i) * Math.cos(i * GOLDEN_ANGLE),
        y: k * Math.sqrt(i) * Math.sin(i * GOLDEN_ANGLE),
        r: moons > 0 ? moonOrbitRadius(scale, moons - 1, false) + moonVisuals('working').discRadius : scale,
        outline: planetOutline(planet, 1, FONT),
        live: spec.status === 'working' || spec.status === 'needs_input',
        released: false,
      }
    }),
    anchors: [{ tagId: 1, x: 0, y: 0 }],
    hole: { x: 100, y: -100 },
  }
}

function mixedCluster(zoom: number): SimState {
  return settledCluster(CLUSTERS['six mixed tiers with moons'], zoom)
}

/** A bare body's box: `r` every way. */
function square(r: number): Extent {
  return { left: -r, right: r, bottom: -r, top: r }
}
