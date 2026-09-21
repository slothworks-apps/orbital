---
id: counter-zoom-inflates-the-whole-moon-system
title: The counter-zoom factor inflates the whole moon system, not just bodies
status: in-force
type: adr
domain: web
related:
  - planets-shrink-slower-than-the-map
  - separation-follows-the-counter-zoom-curve
  - moons-widen-the-body-the-sim-separates
  - the-zoom-range-is-wide-because-fit-is-the-way-back
tags:
  - space-map
  - camera
---
# The counter-zoom factor inflates the whole moon system, not just bodies

`bodyZoomFactor` (camera.ts) makes planets shrink more slowly than the map
when zooming out: `clamp((60 / zoom) ** 0.5, 1, FACTOR_MAX)`, identity at and
above the default zoom. `FACTOR_MAX` is the curve's own value at `MIN_ZOOM`
and moves with it — it was the literal `1.7` while the floor was 20, and is
~3.46 now the floor is 5 ([[the-zoom-range-is-wide-because-fit-is-the-way-back]]).
The open question in
[[planets-shrink-slower-than-the-map]] was whether moons inflate body-only
or orbit-and-all.

**Chosen: the whole system.** The factor is written once onto the moon's
parent-anchored group, so the dashed trail, the orbit radius and the moon's
body scale together with the planet. Visual consistency won over the
tighter spacing: a planet that grows while its moons hold still reads as
two unrelated changes.

The cost accepted with it was that neighbouring moon shells overlapped
somewhat more at far zoom. That cost is **paid off**: separation now
measures from each planet's moon footprint and inflates it by the same
factor, so the shells keep their clearance at every zoom. See
[[separation-follows-the-counter-zoom-curve]] and
[[moons-widen-the-body-the-sim-separates]]. `FACTOR_MAX` no longer needs
lowering to buy spacing back.

Orbit pace is unchanged: the angular speed reads the unscaled
`orbitRadius`, so zooming out never speeds a moon up.
