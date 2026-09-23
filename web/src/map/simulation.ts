/**
 * The tag-cluster spring simulation (canvas 4a/4b, spec
 * 2026-09-18-tag-clusters-design § 1). Bodies hold together by tag on damped
 * springs, settle to rest, wake on drag — and a released body falls into the
 * corner hole on a scripted straight line.
 *
 * This is a direct port of the canvas 4a demo script, which is the tuned
 * reference implementation. d3-force was considered and rejected: its
 * `forceCollide` cannot express the pair-dependent minimum distances below
 * (same-tag vs cross-tag), so every force would have been custom anyway,
 * and its global alpha cooling does not model the per-body sleep the canvas
 * specifies.
 *
 * DETERMINISM CONTRACT: no `Math.random`, no `Date.now`, no reads of
 * anything but the arguments. `stepSimulation` advances fixed 60Hz substeps,
 * so the same reconciled state stepped the same number of times is
 * bit-identical — which is what makes the physics unit-testable in jsdom.
 * The state is mutated in place (one allocation-free object per body, the
 * same discipline as the frame loops in `Planet`/`Moon`), never shared with
 * React: the driver holds it in a ref and applies positions imperatively.
 */

import { REFERENCE_ZOOM } from './camera'
import { PLANET_BASE_RADIUS } from './layout'
import { LABEL_MAX_WIDTH_PX } from './visuals'

// --- Constants, canvas 4a script -------------------------------------------
// The canvas map is pixel-based; its working planet body is r=34px while the
// world's working planet is r=1 unit, so distances convert at 34px = 1 unit.
// Spring constants (k · distance) are scale-invariant and port unchanged;
// fixed accelerations and radii are multiplied by PX.

/** World units per canvas-4a pixel. */
const PX = 1 / 34

/** Spring to the tag's radius-weighted barycentre, per tick (canvas: `0.0011 * bond`). */
const COHESION_K = 0.0011
/** Weak spring to the tag's home anchor, per tick (canvas: `0.0004`). */
const HOME_K = 0.0004
/** Velocity damping per tick (canvas: `* 0.92`). */
const DAMPING = 0.92

/** Clearance kept between same-tag bodies beyond their two reaches (canvas 4a footer: "96 px same tag"; see `minDistance`). */
export const SAME_TAG_GAP = 96 * PX
/** Clearance kept between different-tag bodies beyond their two reaches (canvas 4a footer: "190 px across tags"). */
export const CROSS_TAG_GAP = 190 * PX
/** Separation acceleration once the two footprints touch, same tag (canvas: `0.34` px). */
export const SEPARATION_SAME = 0.34 * PX
/** Separation acceleration once the two footprints touch, different tags (canvas: `0.32` px). */
const SEPARATION_CROSS = 0.32 * PX

/**
 * Half the widest resting planet label, in world units at REFERENCE_ZOOM:
 * the least room any body takes up sideways, whatever its footprint.
 *
 * NOT a canvas 4a value — a deviation from the script. The canvas measures
 * its gaps between bare bodies because its demo planets carry no labels;
 * the map's labels are fixed screen px (`LABEL_MAX_WIDTH_PX`) and do not
 * shrink with the body, so an idle or ended planet's label is wider than
 * its whole footprint pair. Measured against body radii alone, a small
 * planet settled with its label across its neighbour's, and a selected
 * planet's reticle across the next one's state pill (ADR
 * `separation-reaches-at-least-half-a-label`).
 */
export const LABEL_HALF_SPAN = LABEL_MAX_WIDTH_PX / 2 / REFERENCE_ZOOM

/** The hole's repulsion halo (canvas: `hd < 300`): bonded bodies inside get pushed out. */
export const HOLE_REPEL_RADIUS = 300 * PX
/**
 * The drop halo (canvas 4a: the hole's `inset:-46px` gradient, a 71px box):
 * where a released body must land to be absorbed. Also the halo the hint
 * text points at, so `Hole.tsx` draws its band to exactly this radius.
 */
export const HOLE_DROP_RADIUS = 71 * PX
/** Repulsion acceleration at the hole's centre, linear falloff to the halo edge (canvas: `1.1` px). */
const HOLE_REPEL_STRENGTH = 1.1 * PX

/** A sleeping body wakes when net acceleration exceeds this (canvas: `0.025` px). */
const WAKE_ACCEL = 0.025 * PX
/** A body sleeps below this speed… (canvas: `0.03` px) */
const SLEEP_SPEED = 0.03 * PX
/** …and this acceleration (canvas: `0.02` px). */
const SLEEP_ACCEL = 0.02 * PX

/**
 * Fall pull toward the hole, eased in over the first 3 s. NOT the canvas's
 * `0.02` px converted: this map's release distances are proportionally longer
 * in world units than the demo's pixel run, and converting verbatim made a
 * typical fall take ~30 s. Chosen instead from the brief's "straight fall,
 * ~8 s": with FALL_DAMPING the terminal speed is `a·0.975/0.025 ≈ 39a`
 * per tick, so 0.0012 covers a typical ~20-unit release in about 8 s.
 */
const FALL_ACCEL = 0.0012
const FALL_EASE_SEC = 3
/** Falling bodies keep more momentum than held ones (canvas: `* 0.975`). */
const FALL_DAMPING = 0.975
/** Distance at which a falling body is captured — the hole has it (canvas: `d < 34`). */
export const HOLE_CAPTURE_RADIUS = 34 * PX
/** The stretch-along-the-path ramp starts here (canvas: `(260 - d) / 260`)… */
const FALL_STRETCH_RADIUS = 260 * PX
/** …up to this factor at the horizon (canvas: `* 2.4` on top of 1). */
const FALL_STRETCH_MAX = 2.4
/** The body shrinks with d/150px, floored at 0.2 (canvas: `Math.max(0.2, Math.min(1, d / 150))`). */
const FALL_SHRINK_RADIUS = 150 * PX
const FALL_SHRINK_MIN = 0.2

/** Fixed timestep — the canvas script runs at 60Hz and the constants are per-tick. */
const TICK_SEC = 1 / 60
/** Substep cap per stepSimulation call, so a background-tab hiccup never runs a long catch-up loop. */
const MAX_SUBSTEPS = 4
/** settleSimulation's runaway guard, far above any real convergence (~60 s of sim time). */
const SETTLE_MAX_TICKS = 3600

// --- Types ------------------------------------------------------------------

export interface SimBody {
  id: string
  tagId: number
  /**
   * How much room the body takes up, in world units — its tier radius, or
   * its outermost moon shell when the moon system reaches further
   * (`ScenePlanet.footprint`). Separation, the barycentre weighting and the
   * cluster label's anchor all measure from this.
   */
  r: number
  /** working/needs_input: repelled by the hole, never absorbable. */
  live: boolean
  x: number
  y: number
  vx: number
  vy: number
  asleep: boolean
  /** `hold` = bonded; `fall` = released, falling; `gone` = captured by the hole. */
  mode: 'hold' | 'fall' | 'gone'
  /** Pointer-pinned world position while dragged, else null. */
  drag: { x: number; y: number } | null
  /** Seconds since the fall started — drives the ease-in. */
  fallT: number
  /** Fall visuals, written every fall tick: stretch factor along the path… */
  fallStretch: number
  /** …travel direction in radians… */
  fallAngle: number
  /** …and the shrink toward the horizon (1 → FALL_SHRINK_MIN). */
  fallScale: number
}

/** What the driver feeds `reconcileSimulation` — a flattened SceneModel. */
export interface SimInputBody {
  id: string
  tagId: number
  x: number
  y: number
  r: number
  live: boolean
  released: boolean
}

export interface SimInput {
  bodies: SimInputBody[]
  anchors: Array<{ tagId: number; x: number; y: number }>
  hole: { x: number; y: number }
}

export interface SimState {
  bodies: Map<string, SimBody>
  anchors: Map<number, { x: number; y: number }>
  hole: { x: number; y: number }
}

/** What one stepSimulation call reports back to the driver. */
export interface SimEvents {
  /** Bodies the hole captured this call (ring flash + hide, exactly once each). */
  absorbed: string[]
}

// --- API ---------------------------------------------------------------------

export function createSimulation(): SimState {
  return { bodies: new Map(), anchors: new Map(), hole: { x: 0, y: 0 } }
}

/**
 * Brings the sim in line with a fresh scene model: bodies appear at their
 * deterministic seed, leave when the model drops them, change tag or radius
 * in place (the springs then walk them — a retag is a walk, never a cut, per
 * the `retag-migration-motion` ADR), and switch between `hold` and `fall`
 * with the model's `released` flag (an undo re-bonds a falling body).
 *
 * Any structural change wakes every body: a membership change moves
 * barycentres for everyone.
 */
export function reconcileSimulation(sim: SimState, input: SimInput): void {
  let structuralChange = false

  const seen = new Set<string>()
  for (const spec of input.bodies) {
    seen.add(spec.id)
    const existing = sim.bodies.get(spec.id)
    if (!existing) {
      sim.bodies.set(spec.id, {
        id: spec.id,
        tagId: spec.tagId,
        r: spec.r,
        live: spec.live,
        x: spec.x,
        y: spec.y,
        vx: 0,
        vy: 0,
        asleep: false,
        mode: spec.released ? 'fall' : 'hold',
        drag: null,
        fallT: 0,
        fallStretch: 1,
        fallAngle: 0,
        fallScale: 1,
      })
      structuralChange = true
      continue
    }
    if (existing.tagId !== spec.tagId) {
      existing.tagId = spec.tagId
      structuralChange = true
    }
    if (existing.r !== spec.r) {
      // A moon appearing widens the body: everyone has to be awake for the
      // springs to walk the neighbours out, or a sleeping clump would simply
      // keep sitting inside the new footprint.
      existing.r = spec.r
      structuralChange = true
    }
    existing.live = spec.live
    if (spec.released && existing.mode === 'hold') {
      existing.mode = 'fall'
      existing.fallT = 0
      existing.drag = null
      existing.asleep = false
      structuralChange = true
    } else if (!spec.released && existing.mode !== 'hold') {
      // Undo: the bond is back, the springs take over from wherever the
      // body got to — including out of the hole itself.
      existing.mode = 'hold'
      existing.asleep = false
      existing.fallStretch = 1
      existing.fallScale = 1
      structuralChange = true
    }
  }

  for (const id of [...sim.bodies.keys()]) {
    if (!seen.has(id)) {
      sim.bodies.delete(id)
      structuralChange = true
    }
  }

  sim.anchors.clear()
  for (const anchor of input.anchors) sim.anchors.set(anchor.tagId, { x: anchor.x, y: anchor.y })
  sim.hole = { x: input.hole.x, y: input.hole.y }

  if (structuralChange) {
    for (const body of sim.bodies.values()) body.asleep = false
  }
}

/** Where the hole stands toward the current drag — its drop-target signal. */
export type HoleDropState = 'none' | 'eligible' | 'armed'

/**
 * Whether the hole should advertise itself to the body being dragged:
 *
 * - `none` — nothing is dragging, or the dragged body cannot be absorbed
 *   (live, or already falling). The hole shows nothing extra: offering a
 *   target that would refuse the drop would be a lie.
 * - `eligible` — an absorbable body is in hand, anywhere on the map. The
 *   halo brightens a little to say "this is where it can go".
 * - `armed` — the body is inside the drop halo: releasing here absorbs it.
 *
 * `zoomFactor` is `bodyZoomFactor(zoom)` — the same counter-zoom the hole is
 * DRAWN with, and the same factor the release check in `SpaceMap` applies,
 * so what looks inside the halo IS inside it. Pure; read per frame.
 */
export function holeDropState(
  sim: SimState,
  dragId: string | null,
  zoomFactor: number
): HoleDropState {
  if (!dragId) return 'none'
  const body = sim.bodies.get(dragId)
  if (!body || !body.drag || body.live || body.mode !== 'hold') return 'none'
  const d = Math.hypot(body.x - sim.hole.x, body.y - sim.hole.y)
  return d < HOLE_DROP_RADIUS * zoomFactor ? 'armed' : 'eligible'
}

/**
 * Where a body drag's release should move its tag's home — the clump
 * re-settles around wherever you let go (canvas 4a brief), persisted per
 * tag. Null when the release must NOT re-home:
 *
 * - the drop absorbs the body (`armed`): the survivors keep their old home
 *   rather than following the victim to the hole's doorstep;
 * - the drop lands inside the hole's repulsion halo: a home the physics
 *   fights forever is no home, so the clump drifts back instead;
 * - nothing is actually dragging.
 *
 * Live bodies DO re-home — they cannot be absorbed, but moving the clump is
 * exactly what dragging them is for. Read BEFORE `dragSimBody(..., null)`,
 * like `holeDropState`.
 */
export function rehomeTarget(
  sim: SimState,
  dragId: string | null,
  zoomFactor: number
): { tagId: number; x: number; y: number } | null {
  if (!dragId) return null
  const body = sim.bodies.get(dragId)
  if (!body || !body.drag || body.mode !== 'hold') return null
  if (holeDropState(sim, dragId, zoomFactor) === 'armed') return null
  const d = Math.hypot(body.x - sim.hole.x, body.y - sim.hole.y)
  if (d < HOLE_REPEL_RADIUS) return null
  return { tagId: body.tagId, x: body.x, y: body.y }
}

/**
 * Pins a body to the pointer (world coordinates) or releases it (`null`).
 * Waking everyone is what makes the clump trail after the dragged body.
 */
export function dragSimBody(
  sim: SimState,
  id: string,
  position: { x: number; y: number } | null
): void {
  const body = sim.bodies.get(id)
  if (!body) return
  body.drag = position ? { x: position.x, y: position.y } : null
  for (const other of sim.bodies.values()) other.asleep = false
}

/**
 * Advances the simulation by `dtSeconds`, in fixed 60Hz substeps (capped, so
 * a hitched frame catches up smoothly instead of exploding the springs).
 * Deterministic: same state + same dt sequence + same `zoomFactor` =
 * bit-identical results — the zoom arrives as an argument precisely to keep
 * that true, the same way `buildSceneModel` takes its clock as `nowMs`.
 */
export function stepSimulation(sim: SimState, dtSeconds: number, zoomFactor = 1): SimEvents {
  const events: SimEvents = { absorbed: [] }
  const substeps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.round(dtSeconds / TICK_SEC)))
  for (let i = 0; i < substeps; i++) tick(sim, events, zoomFactor)
  return events
}

/**
 * Runs the sim to rest synchronously — the reduced-motion path: falls
 * resolve instantly (no animation to honour) and the springs converge before
 * anything is drawn. Bounded by SETTLE_MAX_TICKS as a runaway guard.
 */
export function settleSimulation(sim: SimState, zoomFactor = 1): SimEvents {
  const events: SimEvents = { absorbed: [] }
  for (const body of sim.bodies.values()) {
    if (body.mode === 'fall') {
      body.mode = 'gone'
      body.fallScale = 0
      events.absorbed.push(body.id)
    }
  }
  for (let i = 0; i < SETTLE_MAX_TICKS; i++) {
    let anyAwake = false
    for (const body of sim.bodies.values()) {
      if (body.mode === 'hold' && !body.asleep) anyAwake = true
    }
    if (!anyAwake) break
    tick(sim, events, zoomFactor)
  }
  return events
}

/**
 * How close two bodies' centres are allowed to get: their two reaches, plus
 * the design's empty clearance between them (SAME_TAG_GAP / CROSS_TAG_GAP,
 * canvas 4a).
 *
 * A body's reach is its footprint, but never less than LABEL_HALF_SPAN:
 * the label under a planet is wider than the planet, and wider still next
 * to an idle or ended one, so two footprints alone let neighbouring labels
 * settle across each other. A planet whose moons reach further than half a
 * label is measured by its moons, exactly as before.
 *
 * The reaches — and only the reaches — are multiplied by `zoomFactor`,
 * which is `bodyZoomFactor(zoom)`: zooming out draws every body up to its
 * cap larger than its world radius, and separation that ignored that would
 * let two inflated moon systems grow through each other at the far view.
 * The clearance itself is left alone. The label's own growth past the
 * counter-zoom at the far view is not tracked: that view is for finding a
 * clump, not for reading its names.
 *
 * Pure and exported for unit tests.
 */
export function minDistance(
  r1: number,
  r2: number,
  sameTag: boolean,
  zoomFactor = 1
): number {
  const reach = (r: number) => Math.max(r, LABEL_HALF_SPAN)
  return (reach(r1) + reach(r2)) * zoomFactor + (sameTag ? SAME_TAG_GAP : CROSS_TAG_GAP)
}

/**
 * The pair the canvas script was tuned against: two active planets, each
 * `PLANET_BASE_RADIUS`. `separation` reproduces the canvas formula exactly
 * at this size and departs from it only as bodies grow past it. The pair's
 * `min` is measured by `minDistance` like any other, so it includes the
 * LABEL_HALF_SPAN floor — wider than the canvas's own bare-body pair.
 */
const referenceMin = (sameTag: boolean) => minDistance(PLANET_BASE_RADIUS, PLANET_BASE_RADIUS, sameTag)

/**
 * Separation acceleration for a pair already inside `min`, at distance `d`.
 *
 * The canvas 4a script pushes with `(min - d) / min * SEPARATION`, which
 * has two problems once a body can be much larger than a bare planet — and
 * with moon footprints, it can:
 *
 * - the ramp is measured against the pair's own `min`, so the same physical
 *   overlap registers as a smaller fraction the bigger the bodies are;
 * - the force tops out at `SEPARATION` however large they are, while the
 *   cohesion spring pulling them back together grows with the clump.
 *
 * So both are measured against the reference pair instead: the ramp over a
 * FIXED distance, and the strength scaled by how big this pair is next to
 * that reference. Separation is then proportional to size, where the
 * canvas's was independent of it — which is what stops a clump from closing
 * over a planet's moons. At the reference pair both corrections are 1 and
 * this is the canvas script, unchanged and bit-identical.
 *
 * Pure and exported for unit tests.
 */
export function separation(min: number, d: number, sameTag: boolean): number {
  const reference = referenceMin(sameTag)
  const strength = (sameTag ? SEPARATION_SAME : SEPARATION_CROSS) * (min / reference)
  return Math.min(1, (min - d) / reference) * strength
}

// --- The tick ----------------------------------------------------------------

/** Scratch barycentre accumulators, keyed by tag — reused across ticks so the loop allocates per tag, not per body. */
interface Centre {
  x: number
  y: number
  w: number
}

function tick(sim: SimState, events: SimEvents, zoomFactor: number): void {
  // Radius-weighted barycentre per tag, over bonded bodies only — a falling
  // body has no bond left to pull with (canvas: `if (n.free) continue`).
  const centres = new Map<number, Centre>()
  for (const body of sim.bodies.values()) {
    if (body.mode !== 'hold') continue
    let centre = centres.get(body.tagId)
    if (!centre) {
      centre = { x: 0, y: 0, w: 0 }
      centres.set(body.tagId, centre)
    }
    centre.x += body.x * body.r
    centre.y += body.y * body.r
    centre.w += body.r
  }
  for (const [tagId, centre] of centres) {
    if (centre.w > 0) {
      centre.x /= centre.w
      centre.y /= centre.w
    } else {
      const anchor = sim.anchors.get(tagId)
      centre.x = anchor?.x ?? 0
      centre.y = anchor?.y ?? 0
    }
  }

  for (const body of sim.bodies.values()) {
    if (body.mode === 'gone') continue
    if (body.mode === 'fall') {
      tickFall(sim, body, events)
      continue
    }
    if (body.drag) {
      body.x = body.drag.x
      body.y = body.drag.y
      body.vx = 0
      body.vy = 0
      body.asleep = false
      continue
    }

    const centre = centres.get(body.tagId)
    const anchor = sim.anchors.get(body.tagId)
    let ax = 0
    let ay = 0
    if (centre) {
      ax += (centre.x - body.x) * COHESION_K
      ay += (centre.y - body.y) * COHESION_K
    }
    if (anchor) {
      ax += (anchor.x - body.x) * HOME_K
      ay += (anchor.y - body.y) * HOME_K
    }

    for (const other of sim.bodies.values()) {
      if (other === body || other.mode !== 'hold') continue
      const dx = body.x - other.x
      const dy = body.y - other.y
      const d = Math.hypot(dx, dy) || 0.01
      const same = other.tagId === body.tagId
      const min = minDistance(body.r, other.r, same, zoomFactor)
      if (d < min) {
        const f = separation(min, d, same)
        ax += (dx / d) * f
        ay += (dy / d) * f
      }
    }

    // The hole never eats a working tag: bonded bodies inside the halo are
    // pushed back out, whatever their status.
    const hdx = body.x - sim.hole.x
    const hdy = body.y - sim.hole.y
    const hd = Math.hypot(hdx, hdy) || 1
    if (hd < HOLE_REPEL_RADIUS) {
      const f = ((HOLE_REPEL_RADIUS - hd) / HOLE_REPEL_RADIUS) * HOLE_REPEL_STRENGTH
      ax += (hdx / hd) * f
      ay += (hdy / hd) * f
    }

    const accel = Math.hypot(ax, ay)
    if (body.asleep) {
      if (accel < WAKE_ACCEL) continue
      body.asleep = false
    }
    body.vx = (body.vx + ax) * DAMPING
    body.vy = (body.vy + ay) * DAMPING
    body.x += body.vx
    body.y += body.vy
    if (Math.hypot(body.vx, body.vy) < SLEEP_SPEED && accel < SLEEP_ACCEL) {
      body.vx = 0
      body.vy = 0
      body.asleep = true
    }
  }
}

/** The scripted straight fall (canvas `stepFalling`): ease in, accelerate at the hole, stretch, shrink, capture. */
function tickFall(sim: SimState, body: SimBody, events: SimEvents): void {
  body.fallT += TICK_SEC
  const dx = sim.hole.x - body.x
  const dy = sim.hole.y - body.y
  const d = Math.hypot(dx, dy) || 1
  const ease = body.fallT < FALL_EASE_SEC ? body.fallT / FALL_EASE_SEC : 1
  body.vx += (dx / d) * FALL_ACCEL * ease
  body.vy += (dy / d) * FALL_ACCEL * ease
  body.vx *= FALL_DAMPING
  body.vy *= FALL_DAMPING
  body.x += body.vx
  body.y += body.vy
  body.fallStretch = 1 + Math.max(0, (FALL_STRETCH_RADIUS - d) / FALL_STRETCH_RADIUS) * FALL_STRETCH_MAX
  body.fallAngle = Math.atan2(dy, dx)
  body.fallScale = Math.max(FALL_SHRINK_MIN, Math.min(1, d / FALL_SHRINK_RADIUS))
  if (d < HOLE_CAPTURE_RADIUS) {
    body.mode = 'gone'
    body.fallScale = 0
    events.absorbed.push(body.id)
  }
}
