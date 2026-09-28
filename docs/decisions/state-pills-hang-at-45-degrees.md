---
id: state-pills-hang-at-45-degrees
title: State pills hang off a planet at 45°
status: in-force
type: adr
domain: web
related:
  - separation-rests-at-the-outline
  - separation-reaches-at-least-half-a-label
tags:
  - space-map
---
# State pills hang off a planet at 45°

## The problem

The state pill, the `/compact` pill and the compacting pill were placed by
their top-left corner at the offsets transcribed from the canvas (1f, 1i).
The pill grows to the right from that corner, so its visual centre sat
around 30–35° above the horizontal — east-north-east, which read as an
arbitrary angle rather than a deliberate one.

## What was chosen

Dot mode's resting disc (the collapsed pill, a circle) centres on the 45°
diagonal. The top-left corner that `<Html>` anchors by is derived from that:
half a disc left and half a disc up from the point on the diagonal. A
label-mode pill is about the disc's height, so its dot lands on the same
spot and the word runs out to the right.

The disc centre's distance from the planet centre (`BADGE_REACH_PX`,
`COMPACT_BADGE_REACH_PX` in `web/src/map/visuals.ts`) started at the old
canvas positions' distance. Seen in the `/sandbox`, the disc then sat right
on the gauged planet's selection ring, so the owner moved both a little
further out.

## What was ruled out

- **Putting the whole pill's centre on 45°.** A long label (`WAITING FOR
  AGENT`) would then reach back over the planet.
- **Updating the canvas first.** The owner decided the canvas stays as it
  is; the code is where this position lives now.

## Consequences

The pills sit a little higher than before, closer to what hangs above the
planet. The simulation measures the pill from the same offsets, so
neighbours keep clear of it without a separate change.
