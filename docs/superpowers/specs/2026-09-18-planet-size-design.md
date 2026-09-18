---
id: 2026-09-18-planet-size-design
title: Appearance — default planet size slider and label scaling
status: done
type: spec
domain: web
related:
  - counter-zoom-inflates-the-whole-moon-system
  - planets-shrink-slower-than-the-map
tags:
  - space-map
  - settings
  - appearance
---
# Appearance — default planet size slider and label scaling

Canvas: `Feature - Planet size.dc.html` (artboards 5a, 5b) in the Claude
Design project. Values from the canvas are orientative by the owner's own
note; behaviour below is what was agreed in chat on 2026-09-18.

## What ships

The Settings dialog's **Appearance** nav item goes live with one section
(`MAP`) holding three rows, per artboard 5a:

1. **Default planet size** — a slider, 0.70×–1.60× in 0.05 steps, default
   1.00×. Readout above the track (`1.00×` plus a note: `default` at 1.00,
   `larger bodies · fewer per screen` above, `denser map` below) and a
   `RESET` pill returning to 1.00×. The canvas's snap-to-1.00 within ±0.03
   is moot: with a 0.05 step the values land on 1.00 exactly.
2. **Preview** — a collapsible row (caret, open by default, `collapsed`
   hint when closed; open state lives only as component state). Three CSS
   mock bodies at 34/60/92 px × scale with a px caption each, transcribed
   from 5a.
3. **Scale labels with bodies** — a toggle, default off.

## Settings keys

Two new rows in `DEFAULT_SETTINGS` (`server/src/db/database.ts`):

- `planet_scale: '1'` — stored as the normalized multiplier (`'0.7'`…
  `'1.6'`), not the slider's percent value.
- `map_scale_labels: 'false'`.

`PATCH /api/settings` already accepts arbitrary keys; no server route
changes.

## Live value flow

The slider is continuous, so the Settings panel's await-then-update rule
(made for discrete clicks) does not apply here. `onChange` writes the
value into the store immediately — the map behind the dialog rescales
live, no Apply — and persists via a PATCH debounced by the panel's
existing `DEBOUNCE_MS` (400 ms). A failed PATCH lands in the error log
([[errors-are-recorded-not-announced]]); the optimistic store value stands
until reload.

Keyboard on the slider: ←/→ one step (native), Shift+←/→ five steps,
Home resets to 1.00× (both via a keydown handler; native Home would go to
the minimum instead).

## Where the multiplier applies

`SpaceMap` reads `planet_scale` (parse, clamp to [0.7, 1.6], NaN → 1).

- **Planet**: the `scale` prop is premultiplied at the call site —
  `scale={pos.scale * planetScale}`. `sceneModel` and `layout` are
  untouched, so orbit radii, moon orbits and cluster spacing do not move
  ("orbit radii are untouched — only bodies resize").
- **Moon**: a new `bodyScale` prop written onto `bodyGroupRef` (the body
  group only). This composes with the counter-zoom factor
  ([[counter-zoom-inflates-the-whole-moon-system]]), which stays on the
  parent-anchored group: zoom inflates the whole system, the slider
  inflates bodies only.
- **Labels**: toggle ON multiplies the title's 11 px and the family line's
  9.5 px by `planetScale`, floored at 10 px / 9.5 px (type floors do not
  scale). Toggle OFF keeps today's fixed sizes. The counter-zoom factor
  never enters the font size — it exists to close the gap between a
  shrinking body and a fixed label.
- **Fixed at every scale**: the NEEDS INPUT badge, mode dots, hairline
  widths ("they are status, not size").

## Out of scope

- Crowding: the canvas's "auto-widen orbit bands above 1.40×" is deferred
  to the planned planet-positioning feature.
- Black hole and Context → Size interactions (neither feature exists).
- Per-session size overrides, zoom behaviour, persistence of the Preview
  row's collapsed state.

## Testing

- Pure helpers carry the logic and the unit tests: `parsePlanetScale`
  (parse + clamp + NaN fallback) and `labelFontPx` (toggle × scale ×
  floors), following the `bodyZoomFactor` pattern — the frame-loop writes
  themselves are invisible to jsdom.
- Settings component tests: slider updates the store immediately, PATCH
  is debounced, RESET returns 1.00×, the toggle PATCHes
  `map_scale_labels`, Appearance is reachable from the nav.
