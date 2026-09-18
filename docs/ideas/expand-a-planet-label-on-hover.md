---
id: expand-a-planet-label-on-hover
title: Expand a planet's label on hover so the whole title can be read
status: done
type: idea
domain: web
related:
  - more-than-one-session-open
tags:
  - space-map
---
# Expand a planet's label on hover so the whole title can be read

A map label is cut at `LABEL_MAX_CHARS = 26` — "Pojďme odbavit nápady v d…" —
and the rest of the title is only reachable by selecting the planet and
reading the detail panel. Hovering should show the whole thing.

## Hover the planet, not the text — agreed

The label is a drei `<Html>` carrying `pointerEvents: 'none'`, so it cannot be
hovered at all today. Turning that on would put a live DOM overlay over the
canvas: a drag that starts on the text would be swallowed instead of panning
the map.

The planet body is already a mesh with an R3F pointer handler on it
(`onClick`), so `onPointerOver` / `onPointerOut` come for free on a target far
bigger than 11px of type. Hover the body, expand its label. No pointer events
on the overlay, and the easier target is the better interaction anyway.

There is no hover state on a planet today — `Planet` takes `onClick` and
nothing else — so this adds the first one, and whatever else wants hover later
(a cursor change, a tooltip) inherits it.

## What expanding means

Render `session.title` in place of `truncateLabel(session.title)` while
hovered. Truncation stays the resting state, which keeps the canvas's "short
names" intent intact.

Three things fall out of it:

- A full title runs wide and will cross its neighbours' labels. The expanded
  form wants a scrim behind it and a raised `zIndexRange` so it reads *over*
  the map rather than tangled into it — or a `max-width` and a second line
  instead of one long run.
- The resting label is `whiteSpace: 'nowrap'`; wrapping, if chosen, is a
  change to that span only.
- Type floors still apply (canvas 5a: 10px mono minimum), so an expanded label
  at low zoom obeys the same floor the resting one does — which is also where
  this helps most, since that is where labels are densest.

The canvas draws no hover states anywhere, so the timing and the scrim are a
judgement call and should be marked as one in the code.

## Not the native tooltip

`title="…"` would cost nothing, but it waits about a second, is drawn by the
OS, and looks like nothing else in the app — the same reason `<select>` is
banned in `web/CLAUDE.md`.
