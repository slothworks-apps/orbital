---
id: fit-runs-away-when-clumps-outgrow-the-strip
title: Fit zooms far out when the clumps are wider than the strip the panels leave
type: fix
status: done
domain: web
related:
  - separation-rests-at-the-outline
tags:
  - space-map
  - camera
---
# Fit zooms far out when the clumps are wider than the strip the panels leave

**Done, 2026-09-23.** The loop is gone: outlines are measured at one fixed
zoom (`OUTLINE_ZOOM`), so the layout no longer changes with the camera and
fit frames one settled copy of it. On `/sandbox/cluster` with the detail
panel open fit now lands on 20, where it used to run down to about 11
without converging. See [[separation-rests-at-the-outline]].

## What happened

Open `/sandbox/cluster` with its default fixture: two clumps, 8 planets,
one selected, so the detail panel is open. Fit settled at about zoom 11
and left most of the strip empty.

`fitViewTo` runs `FIT_SOLVE_ROUNDS` rounds. Each round settled a copy of
the simulation at that round's zoom (`settledCopy`), and outlines were
measured at that zoom. Logged in the browser, the rounds went 400 → 28.0 →
21.0 → 16.9 → 13.8 → 11.4 and never converged: a clump's labels are fixed
CSS px, so its width on screen stayed the same as fit zoomed out, and only
the distance between clumps got smaller.

## What is left

A map whose labelled clumps are wider than the strip still cannot be
framed with every label clear: fit lands below `OUTLINE_ZOOM` and some
labels touch. That is capacity, not a loop, and the ADR's limits record it.
