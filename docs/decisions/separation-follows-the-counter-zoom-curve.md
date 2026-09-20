---
id: separation-follows-the-counter-zoom-curve
title: Separation follows the counter-zoom curve, the map's anchors do not
type: adr
status: in-force
domain: web
related:
  - counter-zoom-inflates-the-whole-moon-system
  - moons-widen-the-body-the-sim-separates
  - planets-shrink-slower-than-the-map
tags:
  - space-map
  - camera
  - simulation
---
# Separation follows the counter-zoom curve, the map's anchors do not

`bodyZoomFactor` draws every body up to 1.7x larger than its world radius
as the camera zooms out, while the distances between them stayed strictly
linear in zoom. The far view was therefore 1.7x denser than the close-up,
relative to body size, and inflated moon systems ran through each other.

## Why the obvious version cancels itself out

The first proposal was to put the curve on the distances too. It does not
work, for a reason worth writing down so nobody rediscovers it: on screen
a body is `r · f(z) · z` and a distance is `d · z`, so the crowding is
exactly `f(z)`. Multiply the distances by `f` as well and the whole image
becomes `world · f(z) · z` — which is the same picture as a plain linear
camera at zoom `f(z) · z`. The curve would stop doing anything visually
and only the mapping of the zoom control would change. Making distances
follow the curve *exactly* is the same thing as deleting the curve.

## What was built instead

The curve is applied to **what separation keeps clear of**, and nothing
else:

```
min = (r₁ + r₂) · bodyZoomFactor(zoom) + gap
```

The footprints inflate with the drawing, so two moon systems keep their
clearance at every zoom. The canvas's empty clearance (96px same tag,
190px across) is left alone, so two moonless planets at the default zoom
rest exactly where they always did. Cluster anchors, the hole's position
and every camera helper are untouched: the big distances across the map
hold, so zooming out still shows the field rather than a 1.7x copy of it.

Clusters that would collide push each other out through the same rule,
with `CROSS_TAG_GAP` — which is what the user asked for: hold the clump
together, and if a wider clump threatens a neighbouring cluster, move the
neighbour.

The zoom reaches the simulation as an argument to `stepSimulation`, not
as a prop: the determinism contract holds (same state, same dt, same
factor, bit-identical result) and camera state still never reaches React.
`SimStepper` reads it off the three camera in its own frame loop.
