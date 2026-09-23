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

import type { ApiSession } from '../lib/types'
import { statePill } from '../lib/types'
import { REFERENCE_ZOOM, bodyZoomFactor } from './camera'
import { PLANET_BASE_RADIUS } from './layout'
import {
  BADGE_OFFSET_X,
  BADGE_OFFSET_Y,
  BRACKET_INSET,
  COMPACT_BADGE_OFFSET_X,
  COMPACT_BADGE_OFFSET_Y,
  HOLE_LABEL_GAP,
  HOLE_RADIUS,
  labelRestY,
  restingLabelSizePx,
  statePillSizePx,
} from './visuals'

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

/**
 * The canvas 4a footer's clearances between two bare bodies: "96 px same
 * tag, 190 px across tags".
 *
 * The map no longer keeps the same-tag one as empty space. The canvas demo
 * planets carry no labels; the map's do, and they are fixed screen px that
 * reach far past the body, so what two neighbours keep clear of is their
 * whole drawn outline (`bodyExtent`) plus NEIGHBOUR_AIR_PX — not the body
 * plus 96 px of nothing (ADR `separation-rests-at-the-outline`). Both
 * values stay for what they still mean:
 *
 * - their DIFFERENCE is how much further off a different tag sits than a
 *   tag-mate (CROSS_TAG_EXTRA), which is what tells two clusters apart;
 * - the same-tag pair of working planets is the pair the canvas tuned its
 *   separation strength against (`REFERENCE_PAIR`).
 */
const CANVAS_SAME_TAG_GAP = 96 * PX
const CANVAS_CROSS_TAG_GAP = 190 * PX
/** How much further apart two bodies of different tags rest than two tag-mates (canvas 4a, the footer's two gaps apart). */
export const CROSS_TAG_EXTRA = CANVAS_CROSS_TAG_GAP - CANVAS_SAME_TAG_GAP
/**
 * Empty room between two neighbours' drawn outlines, in CSS px — so the
 * closest two things on neighbouring planets (a label and a pill, say) are
 * never nearer than this on screen. NOT a canvas value: the canvas has no
 * labels to keep apart. It includes the sliver of contact a settled pair
 * still sits inside `minDistance` (CONTACT_RAMP), so what is left on screen
 * is a little less than this, never nothing.
 */
export const NEIGHBOUR_AIR_PX = 20

/** Separation acceleration at full contact, same tag (canvas: `0.34` px). */
export const SEPARATION_SAME = 0.34 * PX
/** Separation acceleration at full contact, different tags (canvas: `0.32` px). */
const SEPARATION_CROSS = 0.32 * PX
/**
 * How deep into `minDistance` the separation push reaches full strength,
 * as a fraction of that distance.
 *
 * NOT the canvas 4a script's ramp, which spread the push over the whole of
 * `min` (`(min - d) / min`). That ramp is a soft spring: the tag's cohesion
 * leans on it until the two balance, and a settled clump sat at 64–81 % of
 * its `minDistance` — so a distance chosen to clear two labels was where the
 * push began, not where the bodies stopped, and the labels still met
 * (ADR `separation-rests-at-the-outline`). Ramping over a short stretch
 * makes the contact stiff enough that cohesion can only press a pair a
 * percent or two inside it.
 */
const CONTACT_RAMP = 0.03
/**
 * Dashpot on two touching bodies' closing (and parting) speed, per tick.
 * A contact this stiff would ring under DAMPING alone — two bodies meeting
 * would bounce off each other a few times before resting. This damps the
 * pair's relative motion along the line between their centres (the
 * direction the contact pushes in) to about critical, so
 * a collision settles in one approach, the way the canvas's soft ramp did.
 */
const CONTACT_DAMPING = 0.3

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
  /** What the planet draws around itself (label, pill, reticle); null for a bare body. */
  outline: PlanetOutline | null
  /**
   * `bodyExtent` at the zoom of the tick in progress, rewritten in place at
   * the start of every tick so the pair loop reads it instead of re-deriving
   * it for every pair — and without allocating.
   */
  extent: Extent
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
  /** `planetOutline` of the planet; absent for a bare body, measured by `r` alone. */
  outline?: PlanetOutline
  live: boolean
  released: boolean
}

/**
 * Everything a planet draws around its body, in the two units it is drawn
 * in: offsets in local units before the planet's scale (they grow with the
 * body), sizes in CSS px (the label and pill are DOM at a fixed type size).
 * `bodyExtent` turns it into world units at a given zoom.
 */
export interface PlanetOutline {
  /** The planet's drawn scale at REFERENCE_ZOOM: tier scale times the planet-size setting. */
  scale: number
  /** Distance from the centre down to the label's top edge, local units. */
  labelTop: number
  labelWidthPx: number
  labelHeightPx: number
  /** The state pill's top-left corner, local units (x right, y up). */
  pillX: number
  pillY: number
  /** 0 when the planet wears no pill. */
  pillWidthPx: number
  pillHeightPx: number
}

/**
 * The box a body's drawing occupies, as offsets from its centre in world
 * units (`left`/`bottom` negative). Screen-aligned: the label hangs below,
 * the pill to the right, and neither turns with anything.
 */
export interface Extent {
  left: number
  right: number
  bottom: number
  top: number
}

export interface SimInput {
  bodies: SimInputBody[]
  anchors: Array<{ tagId: number; x: number; y: number }>
  /**
   * The hole's centre, and the size of its label column in CSS px
   * (`holeLabelSizePx`); without `label`, only the round repulsion halo
   * keeps bodies away.
   */
  hole: { x: number; y: number; label?: { width: number; height: number } }
}

/** The hole as the tick reads it: its centre and its label column's size, CSS px (0 × 0 for none). */
export interface SimHole {
  x: number
  y: number
  labelWidthPx: number
  labelHeightPx: number
}

export interface SimState {
  bodies: Map<string, SimBody>
  anchors: Map<number, { x: number; y: number }>
  hole: SimHole
}

/** What one stepSimulation call reports back to the driver. */
export interface SimEvents {
  /** Bodies the hole captured this call (ring flash + hide, exactly once each). */
  absorbed: string[]
}

// --- API ---------------------------------------------------------------------

export function createSimulation(): SimState {
  return {
    bodies: new Map(),
    anchors: new Map(),
    hole: { x: 0, y: 0, labelWidthPx: 0, labelHeightPx: 0 },
  }
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
        outline: spec.outline ?? null,
        extent: { left: -spec.r, right: spec.r, bottom: -spec.r, top: spec.r },
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
    if (!sameOutline(existing.outline, spec.outline ?? null)) {
      // Same reason: a pill appearing or a title growing widens what the
      // neighbours have to keep clear of.
      existing.outline = spec.outline ?? null
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
  sim.hole = {
    x: input.hole.x,
    y: input.hole.y,
    labelWidthPx: input.hole.label?.width ?? 0,
    labelHeightPx: input.hole.label?.height ?? 0,
  }

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
 * Deterministic: same state + same dt sequence + same `zoom` = bit-identical
 * results — the camera zoom arrives as an argument precisely to keep that
 * true, the same way `buildSceneModel` takes its clock as `nowMs`.
 */
export function stepSimulation(sim: SimState, dtSeconds: number, zoom = REFERENCE_ZOOM): SimEvents {
  const events: SimEvents = { absorbed: [] }
  const substeps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.round(dtSeconds / TICK_SEC)))
  for (let i = 0; i < substeps; i++) tick(sim, events, zoom)
  return events
}

/**
 * Runs the sim to rest synchronously — the reduced-motion path: falls
 * resolve instantly (no animation to honour) and the springs converge before
 * anything is drawn. Bounded by SETTLE_MAX_TICKS as a runaway guard.
 */
export function settleSimulation(sim: SimState, zoom = REFERENCE_ZOOM): SimEvents {
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
    tick(sim, events, zoom)
  }
  return events
}

/**
 * Where the simulation would come to rest if the camera were at `zoom`,
 * worked out on a copy — `sim` itself is not touched. Every copied body's
 * `extent` is left at that zoom, so the result says both where each body
 * stops and what its drawing covers there.
 *
 * For fit (`fitViewTo`): clumps rest wider the further out the camera is,
 * so framing them where they stand now would frame the wrong picture. An
 * allocation per call, which is fine for a keystroke and never runs in a
 * frame loop.
 */
export function settledCopy(sim: SimState, zoom: number): SimState {
  const copy = createSimulation()
  for (const [id, body] of sim.bodies) {
    // Awake, so a clump resting at another zoom re-spaces for this one;
    // undragged, since the copy has no pointer to follow.
    copy.bodies.set(id, { ...body, extent: { ...body.extent }, drag: null, asleep: false })
  }
  for (const [tagId, anchor] of sim.anchors) copy.anchors.set(tagId, { x: anchor.x, y: anchor.y })
  copy.hole = { ...sim.hole }
  settleSimulation(copy, zoom)
  for (const body of copy.bodies.values()) bodyExtent(body.r, body.outline, zoom, body.extent)
  return copy
}

/**
 * World units per CSS px of the label and pill, as far as separation is
 * concerned: their true size below REFERENCE_ZOOM, and the reference's size
 * above it.
 *
 * The label and pill are DOM at a fixed type size, so zooming out makes
 * them larger in world units — by the whole zoom ratio, not by the
 * counter-zoom curve the bodies follow. Separation that tracked them only
 * as far as the body did (the previous rule) let labels meet as soon as
 * the map was zoomed out a little, which a fit of any map with more than
 * one cluster does.
 *
 * Frozen above the reference, like `bodyZoomFactor`, so zooming in never
 * moves anything: the labels only get smaller relative to the bodies
 * there, and the room kept for them at the reference is then more than
 * enough.
 */
function worldPerPx(zoom: number): number {
  return 1 / Math.min(zoom, REFERENCE_ZOOM)
}

/**
 * Builds a planet's outline from what it will draw. Pure; the map calls it
 * with the scene planet and the Appearance settings that size the drawing
 * (`planetScale`, `labelFontPx`).
 *
 * Selection is deliberately not an input: selecting a planet must not move
 * anything on the map. `Planet` still drops the label under the reticle's
 * brackets while selected, so the outline always measures the label at
 * that dropped position (`labelRestY(gauged, true)`) — the room is kept
 * whether or not the planet is selected, and neither the planet nor its
 * neighbours shift when the selection changes.
 */
export function planetOutline(
  planet: {
    session: Pick<
      ApiSession,
      'title' | 'status' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents'
    >
    scale: number
    modelFamily: string | null
    /** The context gauge moves the label and the pill further out (`Planet`'s `clearsGauge`). */
    gauged: boolean
  },
  planetScale: number,
  labelFont: { title: number; family: number }
): PlanetOutline {
  const label = restingLabelSizePx(planet.session.title, planet.modelFamily?.toUpperCase() ?? null, labelFont)
  const state = statePill(planet.session)
  const pill = state ? statePillSizePx(state.label, state.pulse) : { width: 0, height: 0 }
  return {
    scale: planet.scale * planetScale,
    labelTop: -labelRestY(planet.gauged, true),
    labelWidthPx: label.width,
    labelHeightPx: label.height,
    pillX: planet.gauged ? COMPACT_BADGE_OFFSET_X : BADGE_OFFSET_X,
    pillY: planet.gauged ? COMPACT_BADGE_OFFSET_Y : BADGE_OFFSET_Y,
    pillWidthPx: pill.width,
    pillHeightPx: pill.height,
  }
}

function sameOutline(a: PlanetOutline | null, b: PlanetOutline | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.scale === b.scale &&
    a.labelTop === b.labelTop &&
    a.labelWidthPx === b.labelWidthPx &&
    a.labelHeightPx === b.labelHeightPx &&
    a.pillX === b.pillX &&
    a.pillY === b.pillY &&
    a.pillWidthPx === b.pillWidthPx &&
    a.pillHeightPx === b.pillHeightPx
  )
}

/**
 * The box a body's drawing covers at `zoom`, written into `out` (and
 * returned): the union of
 *
 * - the body, as a square — its moon system (`r`) or the selection
 *   reticle's corner brackets, whichever is wider. The brackets count
 *   whether or not the planet is selected, so the reticle itself never
 *   shoves the neighbours;
 * - the label below it, measured where it hangs while the planet is
 *   selected (`planetOutline`), so the room for the dropped label is
 *   already there and selecting never moves a neighbour;
 * - the state pill to its right, when it wears one.
 *
 * Body parts grow with the counter-zoom (`bodyZoomFactor`), the label and
 * pill with `worldPerPx`. A box and not a circle round the centre, because
 * the label is wide and flat: a circle holding it would also claim the
 * empty space above it, and a clump of such circles packed half again as
 * loosely as its labels needed — too loosely for a fit of several clusters
 * to find any zoom that holds them. Pure; `out` keeps the frame loop free
 * of allocations.
 */
export function bodyExtent(
  r: number,
  outline: PlanetOutline | null,
  zoom: number,
  out: Extent
): Extent {
  const zoomFactor = bodyZoomFactor(zoom)
  let half = r * zoomFactor
  if (!outline) {
    out.left = -half
    out.right = half
    out.bottom = -half
    out.top = half
    return out
  }
  const perPx = worldPerPx(zoom)
  const s = outline.scale * zoomFactor
  half = Math.max(half, BRACKET_INSET * s)
  const labelHalf = (outline.labelWidthPx / 2) * perPx
  out.left = -Math.max(half, labelHalf)
  out.right = Math.max(half, labelHalf)
  out.bottom = -Math.max(half, outline.labelTop * s + outline.labelHeightPx * perPx)
  out.top = half
  if (outline.pillWidthPx > 0) {
    out.right = Math.max(out.right, outline.pillX * s + outline.pillWidthPx * perPx)
    out.top = Math.max(out.top, outline.pillY * s)
  }
  return out
}

/**
 * How steep the roof over a box's top and bottom faces is, as rise over
 * run (see `contact`). Tuned on the three-, four- and six-planet fixtures
 * in `simulation.test.ts`: below about 0.1 a planet still settles almost
 * straight under a neighbour; from about 0.4 clumps spread wide and slow
 * to settle when zoomed out. Two planets exactly one above the other rest
 * this fraction of the narrower half-width further apart than the bare
 * boxes would; anywhere else on the face, less, and nothing at its ends.
 */
const ROOF_SLOPE = 0.2

/**
 * How close two bodies' centres may get when `b` lies in direction
 * (`ux`, `uy`) — a unit vector — from `a`: the distance along that line at
 * which their boxes (`bodyExtent`, at the tick's zoom) stop overlapping
 * with NEIGHBOUR_AIR_PX of screen between them, and CROSS_TAG_EXTRA more
 * between different tags — plus the roof over the top and bottom faces
 * (`contact`).
 *
 * The boxes overlap exactly while `b`'s offset from `a` lies inside one
 * box — `a`'s box grown by `b`'s on every side, plus the gap — so this is
 * where a ray from the centre in that direction leaves it. Side by side
 * that is the two labels' half-widths; one above the other, the label's
 * drop and the body. Symmetric: seen from `b`, the box and the ray are
 * both reversed and the ray leaves at the same distance.
 *
 * Pure and exported for unit tests.
 */
export function minDistance(
  a: Extent,
  b: Extent,
  ux: number,
  uy: number,
  sameTag: boolean,
  zoom = REFERENCE_ZOOM
): number {
  return contact(a, b, ux, uy, pairGap(sameTag, zoom))
}

/** The empty room `minDistance` keeps between two boxes. */
function pairGap(sameTag: boolean, zoom: number): number {
  return NEIGHBOUR_AIR_PX * worldPerPx(zoom) + (sameTag ? 0 : CROSS_TAG_EXTRA)
}

/**
 * `minDistance` with the gap already worked out: where the ray from `a`'s
 * centre in direction (`ux`, `uy`) leaves `a`'s box grown by `b`'s and
 * `gap`, with a shallow gable roof (ROOF_SLOPE) over the grown box's top
 * and bottom faces. The roof's ridge is straight above and below `a`'s
 * centre, and it comes down to the face at the nearer of the two sides.
 * It only ever adds room, so what the boxes keep clear stays clear.
 *
 * The tick pushes along the ray — the line between the two centres, the
 * canvas 4a script's direction — and only the distance comes from here.
 * Both halves of that are needed (ADR `separation-rests-at-the-outline`,
 * the later 2026-09-23 amendment):
 *
 * - Pushed square off the face the boxes meet at, as before, a box much
 *   wider than tall was pushed almost only up and down: nothing moved a
 *   clump sideways, cohesion drew every x onto the barycentre, and three
 *   planets settled as a column, one exactly under the next.
 * - Pushed along the line against a flat face, a planet under two others
 *   was shoved away from the further one's centre, and slid until it sat
 *   almost exactly under the nearer. The roof makes straight under a
 *   neighbour the one place on the face that is not a resting place: the
 *   ridge pushes it off to either side.
 */
function contact(a: Extent, b: Extent, ux: number, uy: number, gap: number): number {
  const right = a.right - b.left + gap
  const left = b.right - a.left + gap
  const alongX = ux > 0 ? right / ux : ux < 0 ? -left / ux : Infinity
  const face = uy > 0 ? a.top - b.bottom + gap : uy < 0 ? b.top - a.bottom + gap : 0
  const across = Math.abs(ux)
  const up = Math.abs(uy)
  const alongY = up > 0 ? face / up : Infinity
  if (alongX <= alongY) return alongX
  // The roof: `rise` above the face at the ridge, down to it `half` either
  // side. Where the ray meets it, if that is before the roof ends.
  const half = Math.min(left, right)
  const rise = ROOF_SLOPE * half
  const onRoof = (face + rise) / (up + (rise * across) / half)
  return across * onRoof < half ? onRoof : alongY
}

/**
 * The box the hole's label column covers at `zoom`, in world coordinates
 * (not offsets: `left` is the box's left edge on the map), written into
 * `out` and returned. Null when the hole has no label.
 *
 * `Hole` draws the column right-aligned HOLE_RADIUS + HOLE_LABEL_GAP left
 * of its centre, scaled by the counter-zoom like the rest of the hole, and
 * centred on it vertically; the text is fixed CSS px, measured with
 * `worldPerPx` like a planet's label.
 *
 * A box, not a wider round halo: the column is a long flat strip reaching
 * well to the left of the disc, and further the more the map is zoomed out.
 * A circle round the hole big enough to cover it would claim a wide ring of
 * empty map above and below the hole as well.
 *
 * Pure and exported for unit tests.
 */
export function holeLabelBox(hole: SimHole, zoom: number, out: Extent): Extent | null {
  if (hole.labelWidthPx <= 0 || hole.labelHeightPx <= 0) return null
  const perPx = worldPerPx(zoom)
  out.right = hole.x - (HOLE_RADIUS + HOLE_LABEL_GAP) * bodyZoomFactor(zoom)
  out.left = out.right - hole.labelWidthPx * perPx
  out.top = hole.y + (hole.labelHeightPx / 2) * perPx
  out.bottom = hole.y - (hole.labelHeightPx / 2) * perPx
  return out
}

/** The hole label's box for the tick in progress, reused so the tick never allocates. */
const HOLE_LABEL_SCRATCH: Extent = { left: 0, right: 0, bottom: 0, top: 0 }

/**
 * The pair the canvas script was tuned against: two bare working planets,
 * each PLANET_BASE_RADIUS, at the canvas's same-tag gap. Separation's
 * strength is scaled by how big a pair is next to this one.
 */
const REFERENCE_PAIR = 2 * PLANET_BASE_RADIUS + CANVAS_SAME_TAG_GAP

/**
 * Separation acceleration for a pair already inside `min`, at distance `d`.
 *
 * The strength is the canvas 4a script's (SEPARATION_SAME /
 * SEPARATION_CROSS), scaled by how big this pair is next to REFERENCE_PAIR,
 * because the cohesion spring pulling a clump together grows with it: a
 * force that topped out at the canvas's value however large the bodies
 * were let a clump close over a planet's moons.
 *
 * It reaches that strength CONTACT_RAMP of the way into `min` — see there
 * for why this is no longer the canvas's whole-of-`min` ramp. Both the
 * strength and the ramp are proportional to `min`, so the contact is
 * equally stiff for every pair: the same overlap pushes the same.
 *
 * Pure and exported for unit tests.
 */
export function separation(min: number, d: number, sameTag: boolean): number {
  const strength = (sameTag ? SEPARATION_SAME : SEPARATION_CROSS) * (min / REFERENCE_PAIR)
  return Math.min(1, (min - d) / (CONTACT_RAMP * min)) * strength
}


// --- The tick ----------------------------------------------------------------

/** Scratch barycentre accumulators, keyed by tag — reused across ticks so the loop allocates per tag, not per body. */
interface Centre {
  x: number
  y: number
  w: number
}

function tick(sim: SimState, events: SimEvents, zoom: number): void {
  for (const body of sim.bodies.values()) bodyExtent(body.r, body.outline, zoom, body.extent)
  const sameGap = pairGap(true, zoom)
  const crossGap = pairGap(false, zoom)
  const holeLabel = holeLabelBox(sim.hole, zoom, HOLE_LABEL_SCRATCH)
  const holeLabelAir = NEIGHBOUR_AIR_PX * worldPerPx(zoom)

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
      const d = Math.hypot(dx, dy)
      // Two bodies on the very same spot part along x, each its own way.
      const ux = d > 0 ? dx / d : body.id < other.id ? 1 : -1
      const uy = d > 0 ? dy / d : 0
      const same = other.tagId === body.tagId
      const min = contact(other.extent, body.extent, ux, uy, same ? sameGap : crossGap)
      if (d < min) {
        // Apart along the line between the centres, and the dashpot along
        // the same line (see `contact` for why not square off the face).
        // `vn` is positive while the two part, negative while they close.
        const vn = (body.vx - other.vx) * ux + (body.vy - other.vy) * uy
        const f = separation(min, d, same) - vn * CONTACT_DAMPING
        ax += ux * f
        ay += uy * f
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
    if (holeLabel) {
      const f = holeLabelPush(body, holeLabel, holeLabelAir)
      ax += HOLE_LABEL_PUSH.x * f
      ay += HOLE_LABEL_PUSH.y * f
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

/** `holeLabelPush`'s direction, written in place so the tick never allocates. */
const HOLE_LABEL_PUSH = { x: 0, y: 0 }

/**
 * How hard the hole's label column pushes `body` out, with the direction
 * written into HOLE_LABEL_PUSH; 0 while the body's box, grown by `air`,
 * stays clear of it.
 *
 * The column does not move, so it pushes square off whichever of its sides
 * the body is least far past — the shortest way out. (The face normal that
 * stacked planets into columns did so between two bodies that both move;
 * against a fixed wall it is simply the way out.) The push has the stiff
 * contact's shape: full HOLE_REPEL_STRENGTH CONTACT_RAMP of the way into
 * the overlap the two boxes can have along that axis, with the
 * CONTACT_DAMPING dashpot on the body's speed along it.
 */
function holeLabelPush(body: SimBody, label: Extent, air: number): number {
  const e = body.extent
  const pastLeft = body.x + e.right + air - label.left
  const pastRight = label.right - (body.x + e.left - air)
  const pastBottom = body.y + e.top + air - label.bottom
  const pastTop = label.top - (body.y + e.bottom - air)
  if (pastLeft <= 0 || pastRight <= 0 || pastBottom <= 0 || pastTop <= 0) return 0
  let depth = pastLeft
  let span = label.right - label.left + e.right - e.left + 2 * air
  HOLE_LABEL_PUSH.x = -1
  HOLE_LABEL_PUSH.y = 0
  if (pastRight < depth) {
    depth = pastRight
    HOLE_LABEL_PUSH.x = 1
  }
  if (pastBottom < depth || pastTop < depth) {
    span = label.top - label.bottom + e.top - e.bottom + 2 * air
    HOLE_LABEL_PUSH.x = 0
    HOLE_LABEL_PUSH.y = pastBottom < pastTop ? -1 : 1
    depth = Math.min(pastBottom, pastTop)
  }
  const vn = body.vx * HOLE_LABEL_PUSH.x + body.vy * HOLE_LABEL_PUSH.y
  return Math.min(1, depth / (CONTACT_RAMP * span)) * HOLE_REPEL_STRENGTH - vn * CONTACT_DAMPING
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
