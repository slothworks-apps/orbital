---
id: docked-panels-are-opaque-not-frosted-glass
title: "The docked panels and map controls are opaque, not frosted glass"
type: adr
status: in-force
domain: map
related:
  - resource-usage-pass-2026-09-24
  - 2026-09-24-map-frame-budget-design
tags:
  - web
  - performance
  - design
---

# The docked panels and map controls are opaque, not frosted glass

## Context

The canvas draws the sidebar and the detail panel (1a/1b/1g) as frosted glass:
a 72–84 % dark gradient with a 22–24 px `backdrop-filter` blur. It draws the
map's zoom and error-log buttons the same way, at 70 % with a 16 px blur.

What sits underneath is the WebGL canvas. The compositor cannot tell that a
redrawn canvas frame is identical, so it recomputes every blur on every map
frame ([[resource-usage-pass-2026-09-24]], finding 1). The frame budget
([[2026-09-24-map-frame-budget-design]]) removed the cost for a still map. But
a map with any moon on it draws at the cap, and at that cap the blur is paid
in full.

At those opacities, over a mostly dark map, the blur showed only a faint
smudge. The subagent panel (11b) already ships with no blur and a 90–94 % fill,
and it does not look out of place next to the others.

## Decision

- The `left` and `right` panel chrome in `web/src/ui/Panel.tsx` drop
  `backdrop-filter` and raise their fill to 92–95 % (sidebar) and 95–97 %
  (detail panel). Their existing hues, edges and shadows stay. The sidebar
  stays the lighter of the two.
- The map's control buttons in `SpaceMap.tsx` drop their blur and raise their
  fill to 92 %.

Blur stays where it is cheap or short-lived:

- the centred modal panels and dialogs, which sit over a scrim and are open
  briefly;
- anchored popups, which are small;
- the reconnecting chip and toasts;
- the PageBar's scrolled state, which blurs the panel's own content, not the
  map.

## Consequences

- No blur is recomputed per map frame during normal use.
- The code departs from the canvas. The canvas should be updated in Claude
  Design to match; otherwise a fidelity pass will bring the glass back.
- Portalled popups and dialogs are unaffected. They were portalled to `<body>`
  because a filtered ancestor traps `position: fixed`, and they still are.
