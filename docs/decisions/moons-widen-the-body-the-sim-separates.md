---
id: moons-widen-the-body-the-sim-separates
title: A planet's moons widen the body the simulation separates
type: adr
status: in-force
domain: web
related:
  - counter-zoom-inflates-the-whole-moon-system
  - custom-spring-sim-over-d3-force
  - planets-shrink-slower-than-the-map
tags:
  - space-map
  - simulation
---
# A planet's moons widen the body the simulation separates

The spring simulation kept bodies apart by `r₁ + r₂ + gap`, where `r` was
the planet's tier radius alone. A session's moons were invisible to it. A
planet carrying three subagents draws a shell well past twice its own
radius, so the clump packed neighbours into space the moon systems were
already using, and the far view — where every body is drawn inflated —
made it worse.

**Chosen: `r` is the body's footprint, not its radius.** `ScenePlanet`
now carries `footprint` — the planet's own layout radius, or its outermost
moon's shell when the moon system reaches further — and that is what
`SpaceMap` feeds the simulation as `r`. A session that spawns a subagent
therefore widens, and the springs walk its neighbours out over about a
second. Nothing jumps: the growth is a change to the rest state, not to
the positions.

Two things had to change with it.

**Reconcile has to wake the clump.** `reconcileSimulation` assigned the
new `r` silently, so a settled clump stayed asleep and simply sat inside
the wider footprint. A changed `r` is now a structural change, like a
retag or a new body.

**Separation had to become proportional to size.** The canvas 4a script
pushes with `(min - d) / min * SEPARATION`: the ramp is measured against
the pair's own minimum distance, so the same physical overlap counts for
less the bigger the bodies are, and the force tops out at `SEPARATION`
however large they get — while the cohesion spring pulling them back
together grows with the clump. Footprints alone were therefore not
enough: a planet with one moon still settled inside its neighbour at far
zoom, and with three moons it did so at the default zoom.

`separation()` measures both against the reference pair instead — the
ramp over a fixed distance, the strength scaled by how big this pair is
next to that reference. Settled nearest-neighbour clearance in a
six-planet clump now holds between 0.5 and 1.3 world units from no moons
to six, at both ends of the zoom range, where before it ran from +1.3
down to −3.8.

At the reference pair both corrections are 1, so a clump of plain active
planets rests exactly where the canvas script put it — verified as
bit-identical in `simulation.test.ts`. Bodies smaller than the reference
(idle, ended) now push a little more gently than the canvas did, which is
the same rule read the other way and is what their smaller bodies want.

Later: a clump of plain active planets no longer rests exactly where the
canvas script put it — every body is now measured as at least half a
label wide, which widens the reference pair too
(`separation-reaches-at-least-half-a-label`).
