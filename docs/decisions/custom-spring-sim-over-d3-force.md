---
id: custom-spring-sim-over-d3-force
title: The cluster physics is a bespoke pure-step sim, not d3-force
status: in-force
type: adr
domain: web
related:
  - 2026-09-18-tag-clusters-design
tags:
  - space-map
  - motion
---
# The cluster physics is a bespoke pure-step sim, not d3-force

## The problem

The tag-clusters map needs a small physics simulation: springs to a tag's
barycentre, a weak home anchor, pair-dependent separation, hole repulsion,
per-body sleep. The obvious question was whether to adopt d3-force — a
tested, tuned solver — or port the canvas 4a demo script by hand.

## The decision

**Bespoke:** `web/src/map/simulation.ts`, a deterministic fixed-timestep
port of the canvas script. d3-force was evaluated and rejected on three
specifics, not on taste:

- `forceCollide` cannot express pair-dependent minimum distances — the
  design keeps `r₁+r₂+96px` within a tag but `190px` across tags — so both
  separation behaviours would already have been custom forces, alongside
  custom barycentre and hole-repulsion forces. The library would have
  contributed only the integrator loop (~30 lines).
- d3's global alpha cooling does not model the canvas's *per-body* sleep
  ("settles to rest, wakes on drag"), and its cooling schedule would have
  needed re-tuning against constants the canvas script already ships tuned.
- Determinism (`simulation.randomSource`, manual `.tick()`) is possible in
  d3 but is the default posture of a hand-rolled step function.

## Consequences

- The sim is pure and clock-free: no `Math.random`, no `Date.now`, fixed
  60Hz substeps. `simulation.test.ts` drives ticks directly and asserts
  convergence, separation, sleep/wake, drag trailing, falls and undo.
- Distances convert from the canvas at 34px = 1 world unit (the canvas's
  own working-planet radius). One deliberate divergence: `FALL_ACCEL` is
  retuned to the brief's "~8 s fall" because this map's release distances
  are proportionally longer than the demo's pixel run — the constant's
  comment carries the derivation.
- The sim state lives in a ref, is reconciled against each scene model
  during render, and is stepped by a `useFrame` callback — positions never
  pass through React state, the same discipline as `transition.ts`.
