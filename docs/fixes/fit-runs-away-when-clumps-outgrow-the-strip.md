---
id: fit-runs-away-when-clumps-outgrow-the-strip
title: Fit zooms far out when the clumps are wider than the strip the panels leave
type: fix
status: backlog
domain: web
related:
  - separation-rests-at-the-outline
tags:
  - space-map
  - camera
---
# Fit zooms far out when the clumps are wider than the strip the panels leave

## What happens

Open `/sandbox/cluster` with its default fixture: two clumps, 8 planets,
one selected, so the detail panel is open. Fit settles at about zoom 11
and leaves most of the strip empty. Before the 2026-09-23 fix that stopped
clusters settling as columns, the same page fitted at zoom 25.

`fitViewTo` runs `FIT_SOLVE_ROUNDS` rounds. Each round settles a copy of
the simulation at that round's zoom (`settledCopy`). Logged in the browser,
the rounds went 400 → 28.0 → 21.0 → 16.9 → 13.8 → 11.4 and never
converged. A clump's labels are fixed CSS px, so its width on screen stays
the same as fit zooms out; only the distance between clumps (world units)
gets smaller. Once the two clumps together are wider than the strip, every
round zooms out a little more, until the rounds run out.

With the detail panel closed, the same fixture fits at about zoom 34.
A clump is wider now that it is a clump and not a column, so it hits this
limit sooner.

## Side effect

The hole stays at its world position (`holePosition`), so at zoom 11 the
clumps reach round it. Its label is kept clear (`holeLabelBox`), but a
planet can rest inside the drawn drop halo: `HOLE_REPEL_RADIUS` is in
world units and not counter-zoomed, while `Hole` draws the halo with the
counter-zoom.

## Where to start

- Stop the solve when a round gains nothing, and fall back to the zoom
  that framed the most, not the last one tried.
- Or place clusters side by side by their settled width, not by the
  layout's bounding circles, so the gap between clumps grows with them.
- Counter-zoom `HOLE_REPEL_RADIUS` the way the halo is drawn.
