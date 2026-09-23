---
id: separation-rests-at-the-outline
title: Planets rest where their drawn outlines meet, at the zoom they are seen at
type: adr
status: in-force
domain: web
related:
  - separation-reaches-at-least-half-a-label
  - separation-follows-the-counter-zoom-curve
  - custom-spring-sim-over-d3-force
  - 2026-09-18-tag-clusters-design
tags:
  - space-map
  - simulation
  - camera
---
# Planets rest where their drawn outlines meet, at the zoom they are seen at

Supersedes [[separation-reaches-at-least-half-a-label]]. After that change,
labels and pills on the map still ran into each other: in a cluster of a
selected planet and two DONE planets, one title lay across a neighbour's
`DONE` pill and another touched a tick ring.

## What was measured

Settled clusters built with `buildSceneModel` and `settleSimulation`
(3, 4 and 6 planets, mixed tiers, with and without moons, one selected),
checked with rectangles built from `Planet`'s own drawing constants.

What a planet of tier scale `s` draws, at the default zoom
(`REFERENCE_ZOOM`, 60 CSS px per world unit):

| part | extent from the centre |
|---|---|
| body / halo / tick ring | 0.48·s / 0.60·s / 0.73·s |
| reticle ring / corner brackets (`BRACKET_INSET`) | 0.88·s / ±0.96·s square |
| label top (`LABEL_TOP_REST_Y`) | 0.81·s below |
| label | up to 189 px wide (26 characters), 32 px tall, both lines |
| state pill (`BADGE_OFFSET_X/Y`) | top-left corner at (0.58·s, 0.60·s), 20.5 px tall |
| pill widths | DONE 45 px, INTERRUPTED 91, NEEDS INPUT 102, WAITING FOR AGENT 142, WAITING FOR AGENTS 149 |

The widest pill is WAITING FOR AGENTS, not NEEDS INPUT.

On main, two things were wrong.

1. **The push was where spacing began, not where it ended.** The canvas
   4a ramp `(min − d) / min` is a soft spring; cohesion leans on it and
   settled same-tag pairs rested at **64–81 %** of `minDistance` (the
   three-planet cluster at 4.60 of 5.97, 77 %). The floor added by the
   previous ADR moved where the push started, not where the bodies stopped.
2. **The label floor followed the wrong curve.** The label and pill are
   fixed CSS px, so zoomed out they grow in world units by the whole zoom
   ratio. The previous floor grew with `bodyZoomFactor`, which is its
   square root. The map almost never sits at the default zoom: fit runs
   on load, and a fit of more than one cluster lands between 20 and 40
   (one cluster 52, two 37.5, three 26.5, four 21.4, in a 1440×860
   window). At the default zoom the three-planet cluster was clear by
   87 px. At zoom 30 its labels overlapped by 14 px. At each map's own fit
   zoom, main had 2, 6 and 15 overlapping label or pill pairs for the two-,
   three- and four-cluster maps. That is the screenshot.

## Considered

- **Raise `SAME_TAG_GAP` / the floor (option b).** The gap would have to
  cover the soft spring's worst rest fraction *and* the far zoom, which
  makes the default view sparse, and it would drift again whenever
  cohesion or the ramp changed. It also does nothing about the zoom curve.
- **A circle round everything a planet draws (tried first).** Two circles
  that do not overlap cannot overlap in anything they draw, so it is
  provably clear. But a circle round a wide, flat label also claims the
  empty space above the label. Clumps packed so loosely that a fit of
  three clusters could not find any zoom that held them: fit went down to
  zoom 8 and the map still overflowed.
- **Box contact pushed along the line between centres.** It packed well,
  but two boxes that meet off-centre shoved each other sideways as well as
  apart. Clumps slid round themselves for up to a minute before they
  slept.
- **Damping the whole relative velocity in contact (friction).** Slower
  to settle than damping the normal alone.

## Chosen

- **Each body is a screen-aligned box** (`bodyExtent`). The box is the
  union of the body square (moon shell, or the reticle brackets, which
  always count so that selecting a planet never shoves its neighbours),
  the label below it and the pill to its right. Label and pill sizes come
  from the real text: `restingLabelSizePx`, `statePillSizePx` and
  `statePill` in `visuals.ts` / `lib/types.ts`, which `Planet` now draws
  with too. The input is a per-planet `PlanetOutline`, built by
  `planetOutline` with the planet-size and label-scale settings.
- **`minDistance(a, b, direction)`** is where the ray from `a` towards `b`
  leaves `a`'s box grown by `b`'s, plus `NEIGHBOUR_AIR_PX` (screen px)
  of air, plus `CROSS_TAG_EXTRA` across tags. Side by side, neighbours
  keep a label width apart. One above the other, they keep the label's
  drop plus the body.
- **Stiff contact.** The push reaches full canvas strength
  `CONTACT_RAMP` of the way into `min`, instead of over the whole of it.
  It pushes along the normal of the face the boxes meet at. A dashpot
  (`CONTACT_DAMPING`) on the closing speed along that normal keeps it
  from bouncing.
- **Labels and pills are measured at their true size below the reference
  zoom** (`worldPerPx`). Above the reference they are frozen, so zooming
  in never moves anything. Bodies still follow `bodyZoomFactor`. This
  changes the rule in [[separation-follows-the-counter-zoom-curve]] for
  labels and pills only.
- **Fit frames where the clumps will rest** (`fitViewTo` in `camera.ts`,
  `settledCopy` in the sim). Clumps now rest wider the further out the
  camera is. Framing the bodies where they stand, or the layout's seeds,
  would frame the wrong picture. Each round of fit's fixed-point solve
  settles a copy at that round's zoom, starting from the previous round's
  copy. The cluster name chip sits above the top of the topmost box, not
  above the bare body.

Canvas 4a provenance stays in the code. The strengths are the canvas's.
`CROSS_TAG_EXTRA` is the difference between the canvas footer's 190 px
and 96 px gaps. The same-tag pair the canvas tuned against remains the
strength reference (`REFERENCE_PAIR`).

## What it changed

Same fixtures, before (main) → after:

| | before | after |
|---|---|---|
| settled pairs as a fraction of `minDistance` | 64–81 % | 98–100 % |
| three-planet cluster (selected + 2 DONE), closest pair, default zoom | 4.60 world | 2.52 stacked / 3.34 side by side |
| label or pill overlaps (< 8 px) in the 3/4/6 clusters at zoom 60, 40, 30, 20 | at zoom 60: pill on label in the four-cluster; at 40 to 20: labels over labels | none; the smallest gap is 15 px |
| overlaps at each map's own fit zoom, 2 / 3 / 4 clusters | 2 / 6 / 15 | 0 / 0 / 0 |
| fit zoom, 1 / 2 / 3 / 4 clusters | 51.7 / 37.5 / 26.5 / 21.4 | 44.7 / 34.0 / 21.2 / 15.7 |
| ticks until every body sleeps (those maps, zoom 60 / 30 / 15) | 413–1155 | 261–790 |

At the default zoom the map is tighter than before, because each pair
rests just past its clearance rather than at an arbitrary fraction of a
large gap. Zoomed out, where the map is actually looked at, it is wider,
because the labels there are wider.

`simulation.test.ts` checks the rest fraction, that a collision does not
bounce, the box geometry and zoom behaviour, and the acceptance itself:
the settled clusters at zoom 60, 40, 26 and 20 have no label or pill
closer than 8 px to anything a neighbour draws, measured with rectangles
built from the drawing constants. The dev route `/sandbox/cluster` shows
the real map over a fixed two-cluster fixture for checking this by eye.

## Limits

- Past the map's capacity, labels cannot all be clear. The capacity is
  roughly 20 labelled planets in a 1440×860 window. Clumps keep their
  screen size as the camera zooms out, and only the space between them
  shrinks. A map of 30 planets fits at zoom 9.5 and overflows the frame
  by about 5 %. That fit takes about 300 ms, against 2–90 ms for the
  maps above.
- Each box is the union of the body, label and pill, so a planet with a
  pill also claims the empty corner under the pill.
- ~~A planet's own reticle brackets still cross its own label.~~
  Resolved 2026-09-23 ([[selection-reticle-drags-the-label]]): a selected
  planet's label drops below the brackets, and `planetOutline` measures it
  there (`labelRestY`). The brackets still always count, so the reticle
  itself never pushes the neighbours. The dropped label does push them:
  selecting a planet moves the neighbour below it by the length of the drop.
- The `/compact` pill on a gauged planet is not measured. It sits where
  the state pill would, and it is narrower than the widest state pills.
