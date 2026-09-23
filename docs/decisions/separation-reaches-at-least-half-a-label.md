---
id: separation-reaches-at-least-half-a-label
title: Separation measures every body as at least half a label wide
type: adr
status: superseded
domain: web
related:
  - moons-widen-the-body-the-sim-separates
  - separation-follows-the-counter-zoom-curve
  - custom-spring-sim-over-d3-force
  - 2026-09-18-tag-clusters-design
tags:
  - space-map
  - simulation
---
# Separation measures every body as at least half a label wide

> **Superseded by [[separation-rests-at-the-outline]] (2026-09-23).** The
> floor was where the push started, not where the bodies stopped: the soft
> ramp still rested pairs at 64–81 % of it. And the label grows with the
> whole zoom ratio, while the floor grew only with the counter-zoom. At the
> zooms fit actually lands on, labels still met. `LABEL_HALF_SPAN` and
> `LABEL_MAX_WIDTH_PX` are gone.

## What overlapped

On a real map with a handful of planets in one tag, three things ran into
each other:

- a planet's label (title + model family line) lay across the next
  planet's label and body;
- a selected planet's reticle sat on a neighbour's state pill;
- a working planet's moon trails ran through a neighbour's label.

## Why the footprint missed it

Measured at the default zoom (`REFERENCE_ZOOM`, 60 CSS px per world unit,
where `bodyZoomFactor` is 1), for a planet of tier scale `s`:

| part | extent from the planet's centre, world units |
|---|---|
| body (`BODY_RADIUS`) | 0.48·s |
| halo ring (`HALO_RING_OUTER`) | 0.60·s |
| reticle ring / corner brackets (`RETICLE_RADIUS`, `BRACKET_INSET`) | 0.88·s / 0.96·s |
| label top (`LABEL_TOP_REST_Y`) | 0.81·s below |
| label height (11 px title line, 5 px gap, 9.5 px family line) | about 32 px = 0.53 |
| label bottom | 1.34 below at s = 1, 0.89 at s = 0.44 |
| label width (26 chars of 11 px mono, 0.06 em tracking) | 189 px = **3.15** (half: 1.57) |
| state pill (`BADGE_OFFSET_X/Y`), `DONE` / `NEEDS INPUT` | from 0.58·s right, 45 px / 102 px wide = 0.75 / 1.7 |

The simulation's footprint `r` is the tier radius — 1, 0.71 or 0.44 — or
the outermost moon shell. `minDistance` asked for `r₁ + r₂ + SAME_TAG_GAP`
(96 canvas px = 2.82 units): 4.82 for two active planets, 3.70 for two
ended ones.

Two things let the labels through:

1. **The label does not scale with the body.** It is fixed screen px, so
   at 3.15 units it is wider than two active footprints (2.0) and far
   wider than two ended ones (0.88).
2. **`minDistance` is where the push starts, not a floor.** Separation is
   a linear ramp against the cohesion spring, and a clump rests where the
   two balance. Settled with the spiral layout's seeds, same-tag pairs sat
   at 64–81 % of their `minDistance`: 3.3–3.9 units between two active
   planets, but 2.24–2.95 between an active and an ended one, or two
   ended ones. Anything under 3.15 puts the two labels on top of each
   other when the planets sit side by side, and under about 3.24 lets a
   selected planet's reticle reach a `NEEDS INPUT` pill.

The spiral layout (`MIN_GAP`, `SPIRAL_SAFETY_MARGIN`) only seeds the
bodies; the simulation moves them before the first frame settles, so the
seed spacing was not the cause.

## Considered

- **Raise `SAME_TAG_GAP`.** It would have to cover the ended pair: with
  the ~64 % rest ratio that is a gap near 4.5 units, which spreads a clump
  of active planets far more than their labels need. The gap is also the
  canvas's number, and it is the label that is new, not the gap.
- **Fold the label into `ScenePlanet.footprint`.** The footprint also
  weights the tag's barycentre and anchors the cluster label above the
  topmost planet; both would have shifted for a reason that has nothing
  to do with them.
- **A hard contact force at the label distance.** It would give a true
  floor, but a stiff spring on top of the canvas's soft one makes
  collisions bouncy under this damping, and it is a larger change to the
  tuned physics than the problem needs.
- **Raise the spiral's `MIN_GAP` / `SPIRAL_SAFETY_MARGIN`.** Seeds only;
  the rest state would not move.

## Chosen

**A body's reach in `minDistance` is `max(r, LABEL_HALF_SPAN)`.**
`LABEL_HALF_SPAN` is half of `LABEL_MAX_WIDTH_PX` (new in `visuals.ts`,
derived from `LABEL_MAX_CHARS`, `LABEL_TITLE_PX`, the mono advance and
`LABEL_TITLE_TRACKING_EM`, which `Planet` now uses for its tracking)
converted at `REFERENCE_ZOOM` — 1.57 units. It is scaled by `zoomFactor`
like the footprint. A moon system that reaches further than half a label
is still measured by its moons; nothing changes for it.

`SAME_TAG_GAP`, `CROSS_TAG_GAP`, the separation strengths and the layout
constants are unchanged and keep their canvas 4a provenance. The
deviation from the canvas is the floor alone, noted at `LABEL_HALF_SPAN`.
Since `separation()` measures its ramp against the reference pair's
`minDistance`, that pair's `min` grew with it (4.82 → 5.97); the canvas's
formula is still applied as is, at the wider pair.

## What it changed

Settled with `settleSimulation` from the spiral seeds, same tag, default
zoom:

| cluster (tier scales, footprints) | closest pair before → after | extent from anchor before → after |
|---|---|---|
| 1, 1 | 3.54 → 4.12 | 1.95 → 2.24 |
| 1, 0.44 | 3.02 → 4.12 | 2.95 → 4.09 |
| 1, 1, 1 | 3.89 → 4.60 | 2.39 → 2.81 |
| 1, 1, 0.71, 0.44 | 2.95 → 4.16 | 2.48 → 3.50 |
| 1, 1, 0.71, 0.71, 0.44, 0.44 | 2.73 → 3.96 | 3.98 → 4.87 |
| six active | 3.33 → 3.92 | 3.66 → 4.15 |
| five ended | 2.24 → 3.64 | 2.39 → 3.21 |
| active with moons (footprint 2.04), 1, 0.71, 0.44 | 2.83 → 4.07 | 5.57 → 5.66 |

Every pair now rests at least 3.55 units apart, a label width plus about
24 px. A box check of labels, bodies, reticles and `NEEDS INPUT` pills
over these clusters found overlaps before (label on label, reticle on
pill) and none after. A clump of active planets is 13–18 % wider; one
that mixes in idle and ended planets grows by about 40 %, because those
were the ones sitting inside each other's labels.

`simulation.test.ts` now checks the floor directly and that a mixed
six-planet cluster settles with every pair more than a label width apart.

## Limits

- The width is the widest resting label, 26 characters. Shorter titles
  get the same room.
- With "Scale labels with bodies" on and the planet-size slider above 1,
  the title grows past `LABEL_MAX_WIDTH_PX` and can touch again.
- Zoomed out, the fixed-px label grows in world units faster than the
  counter-zoom inflates the reach. The far view is for finding clumps,
  not for reading their names, so this is left alone.
