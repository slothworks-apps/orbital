---
id: 2026-10-01-map-themes
title: Map themes — implementation plan
type: plan
status: done
domain: map
related:
  - 2026-10-01-map-themes-design
  - themes-share-one-scene-model-renderer-per-theme
  - desk-mats-order-by-tag-anchors
tags:
  - map
  - web
  - server
---
# Map themes — implementation plan

Implements [[2026-10-01-map-themes-design]] on branch `feat/map-themes`.
Visual reference for Archipelago and Desk: the prototype at
`/tmp/orbital-concepts/detail.html` (tabs *Souostroví* and *Stůl*), built
during the design conversation; the spec wins where they differ.

## Steps

1. **Shell refactor** (web, no visible change)
   - Extract `useMapCamera` and `useMapDrag` from `map/SpaceMap.tsx` into
     `map/shell/`; move the overlays (HUD, zoom column, CTA, error log, camera
     readout, sloth) into `map/shell/MapShell.tsx`.
   - `SpaceMap` becomes the Planets renderer on top of them.
   - Gate: `spacemap.test.tsx`, `moon.test.tsx`, `app.test.tsx` pass with
     assertions unchanged; `npm run test:run -w web`, typecheck, lint.
2. **Theme setting** (web)
   - `mapTheme(settings)` in `store.ts`; Theme row in Settings → Appearance →
     MAP; `planet_scale` row hidden off Planets; `map/MapView.tsx` mounted by
     `App.tsx`.
3. **`recentTools`** (server + web type) — parallel with steps 1–2
   - `RecentToolsStore` beside `SubagentStore`; fed from the runner and the
     transcript path; `recentTools` on `ApiSession` (server `shape.ts`, web
     `lib/types.ts`); tests for summary extraction, cap, drop.
4. **Archipelago** (web) — after 1–3
   - `map/archipelago/geometry.ts` (pure, tested) and the SVG renderer on the
     shell hooks; frame cap via `frameSchedule`.
5. **Desk** (web) — after 1–3, parallel with 4
   - `map/desk/` renderer; pure ordering helpers (tested); inline decision
     answers through the existing decision/question APIs.

## Done when

All five steps are merged, the three themes switch live from Settings, and
the suites pass. Then set this plan and the spec to `done`.
