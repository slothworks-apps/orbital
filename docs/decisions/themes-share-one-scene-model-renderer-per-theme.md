---
id: themes-share-one-scene-model-renderer-per-theme
title: Map themes share one scene model and one camera; each theme is only a renderer
type: adr
status: in-force
domain: map
related:
  - 2026-10-01-map-themes-design
tags:
  - web
  - map
---

# Map themes share one scene model and one camera; each theme is only a renderer

## Context

The map gains two alternative looks, Archipelago and Desk, at full parity with
the planet map ([[2026-10-01-map-themes-design]]). The camera, drag and history
drop logic lived inside `SpaceMap.tsx`, next to the R3F canvas.

## Decision

The map overlays move into `map/shell/`; camera, drag and the history drop are
built from the same pure helpers (`camera.ts`, `trashDropFor`, `setTagAnchor`). Every theme reads the same `useSceneModel()`
and renders it its own way: Planets in R3F, Archipelago in SVG, Desk in DOM.

## Alternatives

- **Archipelago inside the R3F canvas.** Camera, fit and frame budget for free,
  but the 2D drawing would have to be rebuilt from three.js geometry, and Desk
  would still need a separate DOM path — two architectures instead of one.
- **Each theme standalone, no refactor.** Fastest start; camera, drag and
  history would exist three times and parity would drift.

## Consequences

A new theme costs a renderer, not a map. The overlays are shared from the
start; moving `SpaceMap`'s own camera and drag code onto shared hooks is a
separate, behaviour-neutral step ([[spacemap-onto-the-map-shell]]) — the first
attempt at doing it inside this work was dropped as too large to land with it.
