---
id: resizable-detail-panel
title: Let the detail panel be dragged wider
status: done
type: idea
domain: web
related:
  - fold-tool-runs-and-skill-prompts
tags:
  - detail-panel
  - space-map
---
# Let the detail panel be dragged wider

450px is a column for a chat, not for a transcript full of code. A fenced
block wraps or scrolls sideways, a wide table is unreadable, and the only way
to see more is to stop using Orbital and read the file. The panel should have
a drag handle on its inner edge.

## What the width is wired to

The number is not in one place, which is the whole difficulty:

- `Panel`'s `sideWidth` maps `right` to a literal `w-[450px]` (and `left` to
  `300px`), taken verbatim from the export.
- `SpaceMap` hardcodes `DETAIL_PANEL_PX = 450 + 16` and `SIDEBAR_OPEN_PX = 340`
  and feeds them to `centerOn` as insets, so a followed planet lands in the
  free area between the panels rather than behind one. A width the user can
  drag has to reach that calculation, or the camera keeps centring on a
  rectangle that no longer exists.

So the width becomes a value in the store that both read, and `Panel` takes it
as a prop instead of a class. That is the actual change; the handle is the easy
part.

## Two details that will bite

**The existing transition.** `Panel` declares
`transition-[width] duration-[420ms]` for the collapse animation, and
`DetailPanel`'s slide wrapper already carries a comment about not stacking a
second transition-property utility on top of it. A live drag must not animate —
420ms of easing behind the pointer feels broken — so the transition has to be
suppressed while dragging and restored for the collapse.

**Where the number is kept.** There is no `localStorage` anywhere in `web/src`:
`ui` state in the store is per-page-load (the sidebar's collapsed state is lost
on reload too), and everything persisted goes through the settings table and
`PATCH /api/settings`. A panel width is a per-device preference rather than a
product setting, but a new `detail_panel_width` key costs one row and reuses a
path that already works, and the same mechanism would finally make the
sidebar's collapsed state survive a reload. Prefer that over introducing
`localStorage` for one value.

## Bounds

A floor around 360px — below that the header's three-column usage grid and the
composer's action row stop fitting — and a ceiling that leaves the map usable,
something like 60% of the viewport. Double-clicking the handle resets to the
export's 450.

Worth noting this is the cheaper half of the same complaint as
[[fold-tool-runs-and-skill-prompts]]: more room, and less spent on noise.
