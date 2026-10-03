/**
 * The tag-cluster spring simulation (canvas 4a/4b, spec
 * 2026-09-18-tag-clusters-design § 1). Bodies hold together by tag on damped
 * springs, settle to rest and wake on drag, and keep clear of the corner
 * trash, where a dropped body is ended (spec
 * 2026-09-24-sessions-end-only-by-hand-design § 3).
 *
 * It started as a direct port of the canvas 4a demo script, the tuned
 * reference implementation; where it departs from the script (the box
 * outlines, the stiff contact, the packed slots) the constant says so and
 * why. d3-force was considered and rejected: its
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
import { limitPillText } from '../lib/limits'
import { stateDot, type MapStatePills } from '../lib/stateStyle'
import { MAX_FRAME_DELTA_SEC } from './frameSchedule'
import type { TrashDrop } from '../store/store'
import { bodyZoomFactor } from './camera'
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

/** Velocity damping per tick (canvas: `* 0.92`). */
const DAMPING = 0.92
/**
 * Spring from each body to its slot in the clump (`packSlots`), which rides
 * on the tag's radius-weighted barycentre, per tick.
 *
 * NOT the canvas 4a script's `0.0011`, which pulled every body at the
 * barycentre itself and left the clump's shape to separation. With boxes a
 * label wide and not circles, separation alone has no good resting shape:
 * pushed square off the faces, clumps settled as columns; pushed along the
 * line between centres, a body on a face never found a place where the
 * forces balanced and slid for many seconds (ADR
 * `separation-rests-at-the-outline`). The shape now comes from the slots,
 * and this is the spring that holds a body in one. Twice the critical
 * stiffness for DAMPING ((1 − DAMPING)² / 4 per tick²), so a damping ratio
 * of about 0.7: the fastest a spring settles to within a few percent, with
 * an overshoot the contact's dashpot absorbs. A clump of the 3-, 4- or
 * 6-planet fixtures shaken back onto its layout spiral sleeps in 99–159
 * ticks.
 */
const COHESION_K = (1 - DAMPING) ** 2 / 2
/**
 * Spring from the tag's barycentre to its home anchor, per tick, applied to
 * every body alike so the whole clump moves home without being squeezed.
 * NOT the canvas's `0.0004` per body: at that strength a clump took most of
 * ten seconds to creep the last few units home, awake the whole time.
 * As stiff as COHESION_K. Off while a body of the tag is
 * dragged, so the clump trails the pointer (`rehomeTarget` moves the home
 * on release).
 */
const HOME_K = COHESION_K

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
 * pair's relative motion along the contact normal to about critical, so
 * a collision settles in one approach, the way the canvas's soft ramp did.
 */
const CONTACT_DAMPING = 0.3

/** The trash's repulsion halo (canvas: `hd < 300`): resting bodies inside get pushed out. */
export const HOLE_REPEL_RADIUS = 300 * PX
/**
 * The drop halo (canvas 4a: the hole's `inset:-46px` gradient, a 71px box):
 * where a dragged body must be let go to be ended. Also the halo the hint
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

/** Fixed timestep — the canvas script runs at 60Hz and the constants are per-tick. */
const TICK_SEC = 1 / 60
/**
 * Substep cap per stepSimulation call: enough to cover the longest frame the
 * map's frame budget hands out (MAX_FRAME_DELTA_SEC, so the lowest background
 * cap still runs the sim at full speed), and no more, so a hitch never runs a
 * long catch-up loop.
 */
const MAX_SUBSTEPS = Math.ceil(MAX_FRAME_DELTA_SEC / TICK_SEC)
/**
 * How far past a whole tick the accumulated time may be spent early. A 60Hz
 * display whose frames arrive a hair under TICK_SEC apart would otherwise
 * alternate zero ticks and two; with the slack every frame still gets one,
 * and the debt is paid back from the next.
 */
const TICK_SLACK = 0.25
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
   * `bodyExtent`, rewritten in place on every reconcile so the pair loop
   * reads it instead of re-deriving it for every pair.
   */
  extent: Extent
  /** The body's place in its clump (`packSlots`), as an offset from the tag's barycentre. */
  slotX: number
  slotY: number
  /** The body's place on the layout's spiral (`SimInputBody.x`/`y` of the latest reconcile), where `packSlots` starts it from. */
  seedX: number
  seedY: number
  /** What letting go of this body on the trash does (`trashDropFor`). */
  trash: TrashDrop
  x: number
  y: number
  vx: number
  vy: number
  /** This tick's acceleration, gathered for every body before any of them moves. */
  ax: number
  ay: number
  asleep: boolean
  /** Pointer-pinned world position while dragged, else null. */
  drag: { x: number; y: number } | null
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
  trash: TrashDrop
}

/**
 * Everything a planet draws around its body, in the two units it is drawn
 * in: offsets in local units before the planet's scale (they grow with the
 * body), sizes in CSS px (the label and pill are DOM at a fixed type size).
 * `bodyExtent` turns it into world units at OUTLINE_ZOOM.
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
   * The trash's centre, and the size of its label column in CSS px
   * (`holeLabelSizePx`); without `label`, only the round repulsion halo
   * keeps bodies away. Null when the trash is not drawn (`map_show_trash`
   * off): then nothing keeps bodies out of the corner, and nothing is a drop
   * target.
   */
  hole: { x: number; y: number; label?: { width: number; height: number } } | null
}

/** The trash as the tick reads it: its centre and its label column's size, CSS px (0 × 0 for none). */
export interface SimHole {
  x: number
  y: number
  labelWidthPx: number
  labelHeightPx: number
}

export interface SimState {
  bodies: Map<string, SimBody>
  /** Each tag's home as the scene model gives it (the layout's, or the one a drop stored). */
  anchors: Map<number, { x: number; y: number }>
  /**
   * Where each tag's clump actually rests (`placeHomes`): its anchor, moved
   * out just far enough that its packed boxes clear the clumps placed
   * before it. What the home spring pulls to.
   */
  homes: Map<number, { x: number; y: number }>
  /** Null while the trash is hidden — see `SimInput.hole`. */
  hole: SimHole | null
  /**
   * Time handed to stepSimulation and not yet spent on a tick, in seconds —
   * what makes the sim's speed independent of the frame rate. May dip below
   * zero by TICK_SLACK of a tick.
   */
  accumulator: number
}

// --- API ---------------------------------------------------------------------

export function createSimulation(): SimState {
  return {
    bodies: new Map(),
    anchors: new Map(),
    homes: new Map(),
    hole: null,
    accumulator: 0,
  }
}

/**
 * Brings the sim in line with a fresh scene model: bodies appear at their
 * deterministic seed, leave when the model drops them, and change tag or
 * radius in place (the springs then walk them — a retag is a walk, never a
 * cut, per the `retag-migration-motion` ADR).
 *
 * Any structural change wakes every body: a membership change moves
 * barycentres for everyone.
 */
export function reconcileSimulation(sim: SimState, input: SimInput): void {
  let structuralChange = false
  const arrived: SimBody[] = []

  const seen = new Set<string>()
  for (const spec of input.bodies) {
    seen.add(spec.id)
    const existing = sim.bodies.get(spec.id)
    if (!existing) {
      const body: SimBody = {
        id: spec.id,
        tagId: spec.tagId,
        r: spec.r,
        outline: spec.outline ?? null,
        extent: { left: -spec.r, right: spec.r, bottom: -spec.r, top: spec.r },
        slotX: 0,
        slotY: 0,
        seedX: spec.x,
        seedY: spec.y,
        trash: spec.trash,
        x: spec.x,
        y: spec.y,
        vx: 0,
        vy: 0,
        ax: 0,
        ay: 0,
        asleep: false,
        drag: null,
      }
      sim.bodies.set(spec.id, body)
      arrived.push(body)
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
    existing.trash = spec.trash
    existing.seedX = spec.x
    existing.seedY = spec.y
  }

  for (const id of [...sim.bodies.keys()]) {
    if (!seen.has(id)) {
      sim.bodies.delete(id)
      structuralChange = true
    }
  }

  sim.anchors.clear()
  for (const anchor of input.anchors) sim.anchors.set(anchor.tagId, { x: anchor.x, y: anchor.y })
  // The trash appearing or going pushes bodies out of the corner or frees
  // it — either way everyone has to be awake to notice.
  if ((sim.hole === null) !== (input.hole === null)) structuralChange = true
  sim.hole = input.hole && {
    x: input.hole.x,
    y: input.hole.y,
    labelWidthPx: input.hole.label?.width ?? 0,
    labelHeightPx: input.hole.label?.height ?? 0,
  }

  if (structuralChange) {
    for (const body of sim.bodies.values()) {
      bodyExtent(body.r, body.outline, body.extent)
      body.asleep = false
    }
    packSlots(sim)
  }
  // Every reconcile: a drop moves an anchor without changing anything else.
  placeHomes(sim)
  placeArrivals(sim, arrived)
}

/**
 * Puts bodies that just appeared straight into their slots, beside the
 * clump they joined (its barycentre over the bodies already there), or
 * round the tag's anchor when the whole clump is new — on a page load,
 * every clump. Seeded at the layout's spiral instead, a clump started with
 * its boxes piled on one another and spent seconds shoving itself apart.
 */
function placeArrivals(sim: SimState, arrived: SimBody[]): void {
  if (arrived.length === 0) return
  const isNew = new Set(arrived)
  for (const body of arrived) {
    let x = 0
    let y = 0
    let w = 0
    for (const other of sim.bodies.values()) {
      if (other.tagId !== body.tagId || isNew.has(other)) continue
      x += (other.x - other.slotX) * other.r
      y += (other.y - other.slotY) * other.r
      w += other.r
    }
    const home = sim.homes.get(body.tagId)
    const cx = w > 0 ? x / w : (home?.x ?? body.seedX)
    const cy = w > 0 ? y / w : (home?.y ?? body.seedY)
    body.x = cx + body.slotX
    body.y = cy + body.slotY
  }
}

/**
 * How far from `anchor` along (`ux`, `uy`) a clump whose boxes (relative to
 * its barycentre) are `boxes` first clears every box in `placed`, by
 * CROSS_GAP: the stretches of the ray where one of its boxes would overlap
 * one placed, and the nearest free point past them.
 */
function clumpClearAlong(
  boxes: Extent[],
  placed: Extent[],
  anchor: { x: number; y: number },
  ux: number,
  uy: number
): number {
  const blocked: Array<[number, number]> = []
  for (const b of boxes) {
    for (const p of placed) {
      const [inX, outX] = slab(p.left - b.right - CROSS_GAP - anchor.x, p.right - b.left + CROSS_GAP - anchor.x, ux)
      const [inY, outY] = slab(p.bottom - b.top - CROSS_GAP - anchor.y, p.top - b.bottom + CROSS_GAP - anchor.y, uy)
      const enter = Math.max(inX, inY)
      const leave = Math.min(outX, outY)
      if (enter < leave && leave > 0) blocked.push([enter, leave])
    }
  }
  blocked.sort((a, b) => a[0] - b[0])
  let t = 0
  for (const [enter, leave] of blocked) if (enter <= t && t < leave) t = leave
  return t
}

/**
 * Where each tag's clump rests (`sim.homes`): its anchor, or — when its
 * packed boxes there would reach into a clump placed before it, with
 * CROSS_GAP between them — as little further out from the middle of all
 * the anchors as clears them.
 *
 * The layout spaces anchors for bare planets (`clusterAnchors`), and a
 * clump a label wide is several times that. Left at their anchors, two
 * neighbouring clumps pressed into each other: every body's slot spring
 * held it inside the other clump against the contact, and their labels
 * overlapped. Clumps are placed in the scene model's order, so the first
 * keeps its anchor and a new tag never moves the ones already there.
 */
function placeHomes(sim: SimState): void {
  sim.homes.clear()
  let midX = 0
  let midY = 0
  for (const anchor of sim.anchors.values()) {
    midX += anchor.x / sim.anchors.size
    midY += anchor.y / sim.anchors.size
  }
  const placed: Extent[] = []
  for (const [tagId, anchor] of sim.anchors) {
    const boxes: Extent[] = []
    for (const body of sim.bodies.values()) {
      if (body.tagId !== tagId) continue
      const e = body.extent
      boxes.push({
        left: body.slotX + e.left,
        right: body.slotX + e.right,
        bottom: body.slotY + e.bottom,
        top: body.slotY + e.top,
      })
    }
    // Out from the middle first; of SLOT_DIRECTIONS directions, the one
    // that clears in the shortest move keeps the clump nearest its anchor.
    const out = Math.atan2(anchor.y - midY, anchor.x - midX)
    let best = Infinity
    const home = { x: anchor.x, y: anchor.y }
    for (let k = 0; k < SLOT_DIRECTIONS && best > 0; k++) {
      const angle = out + (k * 2 * Math.PI) / SLOT_DIRECTIONS
      const t = clumpClearAlong(boxes, placed, anchor, Math.cos(angle), Math.sin(angle))
      if (t < best - 1e-9) {
        best = t
        home.x = anchor.x + t * Math.cos(angle)
        home.y = anchor.y + t * Math.sin(angle)
      }
    }
    sim.homes.set(tagId, home)
    for (const b of boxes) {
      placed.push({ left: home.x + b.left, right: home.x + b.right, bottom: home.y + b.bottom, top: home.y + b.top })
    }
  }
}

/** Where the trash stands toward the current drag — its drop-target signal. */
export type HoleDropState = 'none' | 'eligible' | 'armed' | 'refused'

/**
 * What the trash says to the body being dragged (spec
 * 2026-09-24-sessions-end-only-by-hand-design § 3):
 *
 * - `none` — nothing is dragging, the trash is hidden, or a body the trash
 *   refuses is in hand but not over it. The trash shows nothing extra:
 *   advertising a target that would refuse the drop would be a lie.
 * - `eligible` — a body the trash takes (`end` or `confirm`) is in hand,
 *   anywhere on the map. The halo brightens a little to say "this is where
 *   it can go".
 * - `armed` — that body is inside the drop halo: letting go ends it (or, for
 *   `confirm`, asks first).
 * - `refused` — a terminal session's body is inside the halo: letting go
 *   does nothing, and it springs back.
 *
 * `zoomFactor` is `bodyZoomFactor(zoom)` — the same counter-zoom the trash is
 * DRAWN with, and the same factor the release check in `SpaceMap` applies,
 * so what looks inside the halo IS inside it. Pure; read per frame.
 */
export function holeDropState(
  sim: SimState,
  dragId: string | null,
  zoomFactor: number
): HoleDropState {
  if (!dragId || !sim.hole) return 'none'
  const body = sim.bodies.get(dragId)
  if (!body || !body.drag) return 'none'
  const inside = Math.hypot(body.x - sim.hole.x, body.y - sim.hole.y) < HOLE_DROP_RADIUS * zoomFactor
  if (body.trash === 'refuse') return inside ? 'refused' : 'none'
  return inside ? 'armed' : 'eligible'
}

/**
 * Where a body drag's release should move its tag's home — the clump
 * re-settles around wherever you let go (canvas 4a brief), persisted per
 * tag. Null when the release must NOT re-home:
 *
 * - the drop lands inside the trash's repulsion halo — whether it ends the
 *   body, opens the End dialog or is refused: the survivors keep their old
 *   home rather than following it to the trash's doorstep, and a home the
 *   physics fights forever is no home, so the clump drifts back instead;
 * - nothing is actually dragging.
 *
 * With the trash hidden there is no halo, and every drop re-homes. Read
 * BEFORE `dragSimBody(..., null)`, like `holeDropState`.
 */
export function rehomeTarget(
  sim: SimState,
  dragId: string | null,
  zoomFactor: number
): { tagId: number; x: number; y: number } | null {
  if (!dragId) return null
  const body = sim.bodies.get(dragId)
  if (!body || !body.drag) return null
  if (sim.hole) {
    const drop = holeDropState(sim, dragId, zoomFactor)
    if (drop === 'armed' || drop === 'refused') return null
    const d = Math.hypot(body.x - sim.hole.x, body.y - sim.hole.y)
    if (d < HOLE_REPEL_RADIUS) return null
  }
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
 * Advances the simulation by `dtSeconds`, in fixed 60Hz ticks. Time
 * accumulates across calls, so a 120Hz display runs one tick every other
 * frame rather than one every frame (which ran the sim at double speed), and
 * a 30 fps cap runs two a frame. Capped at MAX_SUBSTEPS per call, so a
 * hitched frame catches up smoothly instead of exploding the springs.
 * Deterministic: same state + same dt sequence = bit-identical results. The
 * camera does not enter: everything is measured at OUTLINE_ZOOM.
 */
export function stepSimulation(sim: SimState, dtSeconds: number): void {
  sim.accumulator += Math.min(Math.max(0, dtSeconds), MAX_SUBSTEPS * TICK_SEC)
  const substeps = Math.min(MAX_SUBSTEPS, Math.floor(sim.accumulator / TICK_SEC + TICK_SLACK))
  sim.accumulator -= substeps * TICK_SEC
  for (let i = 0; i < substeps; i++) tick(sim)
}

/** Whether any body is still awake. The map keeps drawing frames while this is true. */
export function simulationAwake(sim: SimState): boolean {
  for (const body of sim.bodies.values()) {
    if (!body.asleep) return true
  }
  return false
}

/**
 * Runs the sim to rest synchronously — the reduced-motion path: the springs
 * converge before anything is drawn. Bounded by SETTLE_MAX_TICKS as a
 * runaway guard.
 */
export function settleSimulation(sim: SimState): void {
  for (let i = 0; i < SETTLE_MAX_TICKS; i++) {
    let anyAwake = false
    for (const body of sim.bodies.values()) {
      if (!body.asleep) anyAwake = true
    }
    if (!anyAwake) break
    tick(sim)
  }
}

/**
 * Where the simulation will come to rest, worked out on a copy — `sim`
 * itself is not touched. Every copied body's `extent` is filled in, so the
 * result says both where each body stops and what its drawing covers.
 *
 * For fit (`fitViewTo`), which runs on the first frame, before the live
 * clumps have walked out of their spiral seeds. The layout does not depend
 * on the camera, so one settled copy frames every zoom fit tries. An
 * allocation per call, which is fine for a keystroke and never runs in a
 * frame loop.
 */
export function settledCopy(sim: SimState): SimState {
  const copy = createSimulation()
  for (const [id, body] of sim.bodies) {
    // Undragged, since the copy has no pointer to follow.
    copy.bodies.set(id, { ...body, extent: { ...body.extent }, drag: null, asleep: false })
  }
  for (const [tagId, anchor] of sim.anchors) copy.anchors.set(tagId, { x: anchor.x, y: anchor.y })
  for (const [tagId, home] of sim.homes) copy.homes.set(tagId, { x: home.x, y: home.y })
  copy.hole = sim.hole && { ...sim.hole }
  settleSimulation(copy)
  for (const body of copy.bodies.values()) bodyExtent(body.r, body.outline, body.extent)
  return copy
}

/**
 * The one zoom every outline is measured at: labels and pills at their
 * size in world units there, bodies and moon systems at their counter-zoom
 * (`bodyZoomFactor`) there. The layout never follows the camera.
 *
 * It used to (ADR `separation-rests-at-the-outline`): the labels are fixed
 * CSS px, so measured at the live zoom every box grew as the camera zoomed
 * out, the clumps spread, fit zoomed out further to hold them, and on a map
 * with the detail panel open it never stopped. Measured at one zoom, the
 * layout is a fixed picture and fit frames it in one go.
 *
 * The trade: at zooms above this one the map has more air than it needs;
 * below it, labels on a clump's neighbours can touch, and inflated moon
 * systems can reach each other. It is the bottom of the range the map is
 * worked in — 20 to 35, with the detail panel open on a 16" MacBook
 * (Tomin) — so the whole range is clean, at the price of spare air at its
 * top. A map so big that fit has to go further out is past what can be
 * labelled cleanly anyway (Tomin: overflow on huge maps does not matter).
 */
export const OUTLINE_ZOOM = 20

/** World units per CSS px of a label or pill at OUTLINE_ZOOM. */
const OUTLINE_PER_PX = 1 / OUTLINE_ZOOM
/** The counter-zoom bodies are measured with, at OUTLINE_ZOOM. */
const OUTLINE_BODY_FACTOR = bodyZoomFactor(OUTLINE_ZOOM)

/**
 * Builds a planet's outline from what it will draw. Pure; the map calls it
 * with the scene planet and the Appearance settings that size the drawing
 * (`planetScale`, `labelFontPx`) and the pill mode (`map_state_pills`): a
 * dot-mode pill keeps room only for its resting disc.
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
      | 'title'
      | 'status'
      | 'interruptedAt'
      | 'pendingDecision'
      | 'awaitingSubagents'
      | 'subagents'
      | 'backgroundTasks'
      | 'limitWait'
    >
    scale: number
    modelFamily: string | null
    /** The context gauge moves the label and the pill further out (`Planet`'s `clearsGauge`). */
    gauged: boolean
  },
  planetScale: number,
  labelFont: { title: number; family: number },
  pillMode: MapStatePills
): PlanetOutline {
  const wait = planet.session.limitWait
  const label = restingLabelSizePx(
    planet.session.title,
    planet.modelFamily?.toUpperCase() ?? null,
    labelFont,
    wait ? limitPillText(wait) : null,
  )
  const state = statePill(planet.session)
  const pill = state
    ? statePillSizePx(state.label, stateDot(state.key, pillMode).shape, pillMode)
    : { width: 0, height: 0 }
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
 * The box a body's drawing covers at OUTLINE_ZOOM, written into `out`
 * (and returned): the union of
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
 * Body parts are measured at their counter-zoomed size there
 * (`bodyZoomFactor`), the label and pill at their CSS px there. A box and not a circle round the centre, because
 * the label is wide and flat: a circle holding it would also claim the
 * empty space above it, and a clump of such circles packed half again as
 * loosely as its labels needed — too loosely for a fit of several clusters
 * to find any zoom that holds them. Pure; `out` keeps the frame loop free
 * of allocations.
 */
export function bodyExtent(r: number, outline: PlanetOutline | null, out: Extent): Extent {
  let half = r * OUTLINE_BODY_FACTOR
  if (!outline) {
    out.left = -half
    out.right = half
    out.bottom = -half
    out.top = half
    return out
  }
  const perPx = OUTLINE_PER_PX
  const s = outline.scale * OUTLINE_BODY_FACTOR
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
 * How close two bodies' centres may get when `b` lies in direction
 * (`ux`, `uy`) — a unit vector — from `a`: the distance along that line at
 * which their boxes (`bodyExtent`, at OUTLINE_ZOOM) stop overlapping with
 * NEIGHBOUR_AIR_PX between them, and CROSS_TAG_EXTRA more between
 * different tags.
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
export function minDistance(a: Extent, b: Extent, ux: number, uy: number, sameTag: boolean): number {
  return contact(a, b, ux, uy, sameTag ? SAME_GAP : CROSS_GAP, CONTACT_NORMAL)
}

/** The empty room `minDistance` keeps between two boxes: NEIGHBOUR_AIR_PX at OUTLINE_ZOOM, plus CROSS_TAG_EXTRA across tags. */
const SAME_GAP = NEIGHBOUR_AIR_PX * OUTLINE_PER_PX
const CROSS_GAP = SAME_GAP + CROSS_TAG_EXTRA

/** `contact`'s normal, written in place so the tick never allocates. */
const CONTACT_NORMAL = { x: 0, y: 0 }

/**
 * `minDistance`, plus the side of the grown box the ray leaves through,
 * written into `normal` as a unit axis pointing from `a` towards `b`.
 *
 * Separation pushes along that normal, square off the face the two boxes
 * meet at. That is the direction the overlap shrinks fastest, so a pair
 * pressed together by the slot springs has a place to rest. Pushed along
 * the line between the centres instead, a body resting on a neighbour's
 * face was also shoved along it and slid for seconds before it slept
 * (ADR `separation-rests-at-the-outline`). The face normal on its own let
 * clusters settle as columns; the slots (`packSlots`) now decide where a
 * body sits, and separation only keeps boxes apart.
 */
function contact(
  a: Extent,
  b: Extent,
  ux: number,
  uy: number,
  gap: number,
  normal: { x: number; y: number }
): number {
  const alongX =
    ux > 0 ? (a.right - b.left + gap) / ux : ux < 0 ? (a.left - b.right - gap) / ux : Infinity
  const alongY =
    uy > 0 ? (a.top - b.bottom + gap) / uy : uy < 0 ? (a.bottom - b.top - gap) / uy : Infinity
  if (alongX <= alongY) {
    normal.x = Math.sign(ux)
    normal.y = 0
    return alongX
  }
  normal.x = 0
  normal.y = Math.sign(uy)
  return alongY
}

/**
 * Where each body of each tag sits in its clump, as an offset from the
 * tag's radius-weighted barycentre, written into `slotX`/`slotY`.
 *
 * Each body starts from its place on the layout's golden-angle spiral
 * (`seedX`/`seedY`, `layoutClusters`), which is spaced for bare planets
 * and far too tight for boxes a label wide. Bodies are taken in the scene
 * spiral's order, middle out. Each looks from its spiral place in
 * SLOT_DIRECTIONS directions, goes along each only as far as it takes for
 * its box to clear every box already placed by SAME_GAP, and of those
 * spots keeps the one closest to the barycentre of the bodies placed so
 * far — measured in box widths and box heights, so a place beside the
 * clump counts the same as one above it. So each box fills in round the
 * middle, against its neighbours: the clump is as tight as its labels
 * allow, and it does not stack up into a column. Starting each search from
 * the spiral place keeps a body on the side of the clump it was seeded on,
 * so no two bodies have to pass through each other to reach their slots.
 *
 * Runs on reconcile, when a body arrives, leaves, changes tag or changes
 * size — never in the frame loop. Deterministic: the same model always
 * packs the same way.
 */
function packSlots(sim: SimState): void {
  const byTag = new Map<number, SimBody[]>()
  for (const body of sim.bodies.values()) {
    let members = byTag.get(body.tagId)
    if (!members) {
      members = []
      byTag.set(body.tagId, members)
    }
    members.push(body)
  }
  for (const [tagId, members] of byTag) {
    // Middle out, as the spiral numbers them: the spiral's centre is the
    // tag's anchor (`layoutClusters`), and a body's distance from it is
    // its place in the spiral. Ties (never in practice) by id.
    const anchor = sim.anchors.get(tagId) ?? { x: members[0].seedX, y: members[0].seedY }
    const fromAnchor = (b: SimBody) => Math.hypot(b.seedX - anchor.x, b.seedY - anchor.y)
    members.sort((a, b) => fromAnchor(a) - fromAnchor(b) || (a.id < b.id ? -1 : 1))

    // The clump's typical box, to measure a move in box units: a box is
    // much wider than tall, and measured in world units the shortest way
    // out of an overlap is nearly always straight up or down.
    let boxW = 0
    let boxH = 0
    for (const body of members) {
      boxW += body.extent.right - body.extent.left + SAME_GAP
      boxH += body.extent.top - body.extent.bottom + SAME_GAP
    }
    boxW /= members.length
    boxH /= members.length

    let sumX = 0
    let sumY = 0
    let weight = 0
    for (let i = 0; i < members.length; i++) {
      const body = members[i]
      body.slotX = body.seedX
      body.slotY = body.seedY
      if (i > 0) {
        const cx = sumX / weight
        const cy = sumY / weight
        // Out from the middle first: a tie keeps the outward direction.
        const out = Math.atan2(body.seedY - anchor.y, body.seedX - anchor.x)
        let best = Infinity
        for (let k = 0; k < SLOT_DIRECTIONS; k++) {
          const angle = out + (k * 2 * Math.PI) / SLOT_DIRECTIONS
          const ux = Math.cos(angle)
          const uy = Math.sin(angle)
          const t = clearAlong(members, i, body.seedX, body.seedY, ux, uy)
          const x = body.seedX + t * ux
          const y = body.seedY + t * uy
          const spread = ((x - cx) / boxW) ** 2 + ((y - cy) / boxH) ** 2
          if (spread < best - 1e-12) {
            best = spread
            body.slotX = x
            body.slotY = y
          }
        }
      }
      sumX += body.slotX * body.r
      sumY += body.slotY * body.r
      weight += body.r
    }
    // Relative to the barycentre, which is what the tick measures from.
    for (const body of members) {
      body.slotX -= sumX / weight
      body.slotY -= sumY / weight
    }
  }
}

/** How many directions `packSlots` tries for each body: enough that one of them lands close to any gap. */
const SLOT_DIRECTIONS = 24

/**
 * How far from (`ox`, `oy`) along (`ux`, `uy`) `members[i]`'s box first
 * clears the boxes of `members[0..i-1]`, already placed at their slots.
 * Each placed box rules out one stretch of the ray (where it runs through
 * that box grown by the newcomer's, and SAME_GAP); the answer is the
 * nearest point outside all of them.
 */
function clearAlong(members: SimBody[], i: number, ox: number, oy: number, ux: number, uy: number): number {
  const e = members[i].extent
  let t = 0
  // Each pass moves t past every stretch it sits in; t only grows, so a
  // stretch passed is never re-entered and i + 1 passes always end free.
  for (let pass = 0; pass <= i; pass++) {
    let moved = false
    for (let j = 0; j < i; j++) {
      const o = members[j]
      const [inX, outX] = slab(
        o.slotX + o.extent.left - e.right - SAME_GAP - ox,
        o.slotX + o.extent.right - e.left + SAME_GAP - ox,
        ux
      )
      const [inY, outY] = slab(
        o.slotY + o.extent.bottom - e.top - SAME_GAP - oy,
        o.slotY + o.extent.top - e.bottom + SAME_GAP - oy,
        uy
      )
      const enter = Math.max(inX, inY)
      const leave = Math.min(outX, outY)
      if (enter < leave && t >= enter && t < leave) {
        t = leave
        moved = true
      }
    }
    if (!moved) break
  }
  return t
}

/** The stretch of the ray `t · u` (one axis of it) that lies between `lo` and `hi`. */
function slab(lo: number, hi: number, u: number): [number, number] {
  if (u === 0) return lo < 0 && 0 < hi ? [-Infinity, Infinity] : [Infinity, -Infinity]
  const a = lo / u
  const b = hi / u
  return a < b ? [a, b] : [b, a]
}

/**
 * The box the hole's label column covers at OUTLINE_ZOOM, in world
 * coordinates (not offsets: `left` is the box's left edge on the map),
 * written into `out` and returned. Null when the hole has no label.
 *
 * `Hole` draws the column right-aligned HOLE_RADIUS + HOLE_LABEL_GAP left
 * of its centre, scaled by the counter-zoom like the rest of the hole, and
 * centred on it vertically; the text is fixed CSS px, measured at
 * OUTLINE_ZOOM like a planet's label.
 *
 * A box, not a wider round halo: the column is a long flat strip reaching
 * well to the left of the disc. A circle round the hole big enough to cover
 * it would claim a wide ring of empty map above and below the hole as well.
 *
 * Pure and exported for unit tests.
 */
export function holeLabelBox(hole: SimHole, out: Extent): Extent | null {
  if (hole.labelWidthPx <= 0 || hole.labelHeightPx <= 0) return null
  out.right = hole.x - (HOLE_RADIUS + HOLE_LABEL_GAP) * OUTLINE_BODY_FACTOR
  out.left = out.right - hole.labelWidthPx * OUTLINE_PER_PX
  out.top = hole.y + (hole.labelHeightPx / 2) * OUTLINE_PER_PX
  out.bottom = hole.y - (hole.labelHeightPx / 2) * OUTLINE_PER_PX
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
  /** A body of this tag is in hand: the clump follows the pointer, not its home. */
  held: boolean
}

/**
 * How far from its slot a body is still on its way there, as a fraction of
 * its box's height. Two tag-mates either of which is further than this
 * from its slot do not push each other: the slots never overlap, so they
 * only meet in passing, and pushing each other aside there sent a clump
 * that had to rearrange itself (a planet joining, a moon widening one) the
 * long way round its neighbours. Measured on the six-planet fixture shaken
 * back onto its spiral: up to 512 ticks to sleep with every pair pushing,
 * under 160 with this.
 */
const TRAVELLING = 0.5

/** Whether `body` is still on its way to its slot. A body in hand never is: its tag-mates keep off it. */
function travelling(body: SimBody, centre: Centre): boolean {
  if (body.drag) return false
  const dx = centre.x + body.slotX - body.x
  const dy = centre.y + body.slotY - body.y
  return Math.hypot(dx, dy) > TRAVELLING * (body.extent.top - body.extent.bottom)
}

function tick(sim: SimState): void {
  const hole = sim.hole
  const holeLabel = hole && holeLabelBox(hole, HOLE_LABEL_SCRATCH)

  // Radius-weighted barycentre per tag.
  const centres = new Map<number, Centre>()
  for (const body of sim.bodies.values()) {
    let centre = centres.get(body.tagId)
    if (!centre) {
      centre = { x: 0, y: 0, w: 0, held: false }
      centres.set(body.tagId, centre)
    }
    centre.x += body.x * body.r
    centre.y += body.y * body.r
    centre.w += body.r
    if (body.drag) centre.held = true
  }
  for (const [tagId, centre] of centres) {
    if (centre.w > 0) {
      centre.x /= centre.w
      centre.y /= centre.w
    } else {
      const anchor = sim.homes.get(tagId)
      centre.x = anchor?.x ?? 0
      centre.y = anchor?.y ?? 0
    }
  }

  // Drags first: they are placed, not pushed.
  for (const body of sim.bodies.values()) {
    if (body.drag) {
      body.x = body.drag.x
      body.y = body.drag.y
      body.vx = 0
      body.vy = 0
      body.asleep = false
    }
  }

  for (const body of sim.bodies.values()) {
    body.ax = 0
    body.ay = 0
    if (body.drag) continue
    const centre = centres.get(body.tagId)
    const anchor = sim.homes.get(body.tagId)
    let ax = 0
    let ay = 0
    if (centre) {
      // To its slot, which rides on the barycentre — so dragging one body
      // moves the barycentre and the rest of the clump trails after it.
      ax += (centre.x + body.slotX - body.x) * COHESION_K
      ay += (centre.y + body.slotY - body.y) * COHESION_K
      // The whole clump home, every body alike — except while one of it is
      // in hand: then it follows the pointer, and the release re-homes it.
      if (anchor && !centre.held) {
        ax += (anchor.x - centre.x) * HOME_K
        ay += (anchor.y - centre.y) * HOME_K
      }
    }

    for (const other of sim.bodies.values()) {
      if (other === body) continue
      const dx = body.x - other.x
      const dy = body.y - other.y
      const d = Math.hypot(dx, dy)
      // Two bodies on the very same spot part along x, each its own way.
      const ux = d > 0 ? dx / d : body.id < other.id ? 1 : -1
      const uy = d > 0 ? dy / d : 0
      const same = other.tagId === body.tagId
      // Two tag-mates on their way to their slots pass through each other.
      if (same && centre && (travelling(body, centre) || travelling(other, centre))) continue
      const min = contact(other.extent, body.extent, ux, uy, same ? SAME_GAP : CROSS_GAP, CONTACT_NORMAL)
      if (d < min) {
        const nx = CONTACT_NORMAL.x
        const ny = CONTACT_NORMAL.y
        // Positive while the two are parting, negative while closing.
        const vn = (body.vx - other.vx) * nx + (body.vy - other.vy) * ny
        const f = separation(min, d, same) - vn * CONTACT_DAMPING
        ax += nx * f
        ay += ny * f
      }
    }

    // Nothing ends up in the trash by drifting: resting bodies inside the
    // halo are pushed back out, whatever their status — only a drop ends one.
    if (hole) {
      const hdx = body.x - hole.x
      const hdy = body.y - hole.y
      const hd = Math.hypot(hdx, hdy) || 1
      if (hd < HOLE_REPEL_RADIUS) {
        const f = ((HOLE_REPEL_RADIUS - hd) / HOLE_REPEL_RADIUS) * HOLE_REPEL_STRENGTH
        ax += (hdx / hd) * f
        ay += (hdy / hd) * f
      }
    }
    if (holeLabel) {
      const f = holeLabelPush(body, holeLabel, SAME_GAP)
      ax += HOLE_LABEL_PUSH.x * f
      ay += HOLE_LABEL_PUSH.y * f
    }
    body.ax = ax
    body.ay = ay
  }

  // Integrate only once every force is in, all read from the same
  // positions. Moving each body as soon as its own force was known (the
  // canvas script's order) let the one moved first see its neighbours
  // where they were and the one moved last see them where they had gone,
  // so a touching pair's two pushes did not quite cancel.
  for (const body of sim.bodies.values()) {
    if (body.drag) continue
    const accel = Math.hypot(body.ax, body.ay)
    if (body.asleep) {
      if (accel < WAKE_ACCEL) continue
      body.asleep = false
    }
    body.vx = (body.vx + body.ax) * DAMPING
    body.vy = (body.vy + body.ay) * DAMPING
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
