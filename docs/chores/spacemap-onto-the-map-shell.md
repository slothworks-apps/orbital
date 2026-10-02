---
id: spacemap-onto-the-map-shell
title: Move SpaceMap onto the shared map shell
type: chore
status: backlog
domain: map
related:
  - themes-share-one-scene-model-renderer-per-theme
  - 2026-10-01-map-themes-design
tags:
  - web
  - map
---
# Move SpaceMap onto the shared map shell

The Archipelago and Desk themes draw their overlays through
`map/shell/MapShell.tsx`; the planet map still draws its own copy inside
`SpaceMap.tsx`, and keeps its camera and drag code there too.

Move `SpaceMap`'s overlays onto `MapShell`, and extract its camera (pan, wheel
zoom, flights, fit, follow-selected) and its body drag / history drop into
hooks the Archipelago map can share. No visible change; `spacemap.test.tsx`
must pass with its assertions unchanged.
