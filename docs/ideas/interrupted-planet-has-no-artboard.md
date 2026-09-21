---
id: interrupted-planet-has-no-artboard
title: The interrupted planet borrows a pill instead of having a state
status: backlog
type: idea
domain: map
related:
  - 2026-09-21-session-autoheal-design
tags:
  - design
---

# The interrupted planet borrows a pill instead of having a state

Autoheal gave sessions a fifth thing they can be: resumed after a restart
that cut their turn short. The map says so by reusing the `NEEDS INPUT` pill
with a different word and no blinking dot
(spec `2026-09-21-session-autoheal-design` § 4).

That was deliberate, not an oversight. The state sheet (artboard 1f) draws
four states, and `web/src/map/visuals.ts` is a value-for-value transcription
of it — tick opacity, arc spin, core radius, halo. Inventing a fifth row of
those numbers would put geometry on the map that the canvas does not
describe, which is the one thing `web/CLAUDE.md` forbids outright.

So the pill is an interim, and it has a real cost: an interrupted planet is
geometrically identical to one merely waiting for input. You have to read the
word. On a map of twenty bodies, that is exactly the scan autoheal exists to
spare.

**What it needs:** an `interrupted` column on artboard 1f, in the canvas's own
terms — what the ticks, the arc, the core and the halo do for a session that
stopped rather than one that is waiting. Then the transcription into
`PlanetVisuals`, and the pill can keep its word or lose it.

The canvas is the blocker, not the code. `PlanetVisuals` already selects per
state; a fifth entry is a small change once there is something to copy.
