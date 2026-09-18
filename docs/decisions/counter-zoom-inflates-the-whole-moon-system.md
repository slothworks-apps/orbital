---
id: counter-zoom-inflates-the-whole-moon-system
title: The counter-zoom factor inflates the whole moon system, not just bodies
status: in-force
type: adr
domain: web
related:
  - planets-shrink-slower-than-the-map
tags:
  - space-map
  - camera
---
# The counter-zoom factor inflates the whole moon system, not just bodies

`bodyZoomFactor` (camera.ts) makes planets shrink more slowly than the map
when zooming out: `clamp((60 / zoom) ** 0.5, 1, 1.7)`, identity at and above
the default zoom. The open question in
[[planets-shrink-slower-than-the-map]] was whether moons inflate body-only
or orbit-and-all.

**Chosen: the whole system.** The factor is written once onto the moon's
parent-anchored group, so the dashed trail, the orbit radius and the moon's
body scale together with the planet. Visual consistency won over the
tighter spacing: a planet that grows while its moons hold still reads as
two unrelated changes.

The cost accepted with it: at the factor cap the outermost moon shells
reach ~2.3 world units, and neighbouring shells (already past the 2.5
minimum spacing today at 1.35 + 1.35) overlap somewhat more at far zoom.
If that reads badly on the canvas, lower `FACTOR_MAX` before reshaping the
mechanism — the constants sit together in `camera.ts`.

Orbit pace is unchanged: the angular speed reads the unscaled
`orbitRadius`, so zooming out never speeds a moon up.
