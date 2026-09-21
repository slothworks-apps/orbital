---
id: 2026-09-21-fit-honours-the-panels-design
title: Fit honours the panels, and the sidebar can be dragged wider
type: spec
status: done
domain: map
related:
  - resizable-detail-panel
  - the-zoom-range-is-wide-because-fit-is-the-way-back
  - selected-session-lives-in-the-url-query
  - the-zoom-buttons-ease-in-log-space
tags:
  - space-map
  - camera
  - sidebar
---

# Fit honours the panels, and the sidebar can be dragged wider

Four changes that all come from one place: the map is drawn full-bleed, but
it is *seen* through the strip between the sidebar and the detail panel, and
until now only the follow-the-selected-planet camera knew that.

## 1. Fit frames the strip, not the viewport

`fitView` takes an `Insets { left, right }` and fits the bounding box into
`viewport.width - left - right`, then centres it in that strip with the same
half-difference offset `centerOn` already used. Without insets it behaves
exactly as before, so the signature stays back-compatible.

`SpaceMap` derives the insets live from both panels:

| edge | open | closed |
|---|---|---|
| left | `sidebar_width + 40` | `96` (the rail) |
| right | `detail_panel_width + 16` | `0` (nothing selected) |

The 40 is the sidebar's 16px edge inset plus a 24px gutter — the same
arithmetic the collapsed rail's 96 (16 + 56 + 24) comes from. The follow
camera and the HUD's bottom-left camera readout read the same value, so
there is one definition of "where the map is covered".

A strip narrower than 20% of the viewport is treated as 20%: both panels
open on a very narrow window would otherwise divide by roughly zero.

## 2. Fit on load

A reload used to land on a fixed default camera (origin, zoom 60). On a map
that has grown past that frame, that means opening to empty space and going
to find your own sessions. The map now fits once per page load.

It waits for **two** conditions, not one: sessions to frame, and
`ui.urlRestored` — the flag `lib/sessionUrl.ts` sets when the `?session=`
restore has settled. Fitting the moment planets exist would frame the full
viewport and then let the deep link's detail panel open over the result,
which is the exact bug the insets exist to fix.

Once only. Re-fitting on window resize or on a panel opening was considered
and **cut**: after the user has touched the camera it is theirs, and a map
that re-frames itself under a moving hand is worse than one that does
nothing. The way back is one keystroke.

## 3. ⌥F

The zoom stack's ⌖ button keeps its "Fit view" label and gains the shortcut
in its tooltip. ⌥F is matched on `e.code === 'KeyF'` and ignored while the
user is typing — the same handling, and for the same reason, as ⌥N: on a US
layout ⌥F arrives as `ƒ`, so the physical key is what is meant.

## 4. The sidebar is resizable

A mirror of the detail panel's handle (`resizable-detail-panel`), down to the
optimistic save: an inner-edge `role="separator"`, live width through
`Panel`'s `widthPx`, the store value moving during the drag and one PATCH on
release, double-click to reset. It shares `ui.resizingPanel`, so the map's
overlays drop their position transition and track the pointer with it.

- stored as `sidebar_width`, default **300** (canvas 1a), clamped to
  **[280, 45% of the viewport]** with the floor winning on a narrow window
- the ceiling is lower than the detail panel's 60%: the sidebar is a list,
  not a reading surface, and both can be open at once
- hidden while collapsed — the rail has one width, and the way back out of
  it is the expand toggle
- the expanded content layer is absolutely positioned so it can cross-fade
  against the rail, so it does not inherit the panel's width and is given it
  inline

## Testing

The arithmetic is unit-tested in `camera.ts` (fit into a strip, centring,
the tighter axis, panels wider than the viewport). The state transitions are
driven through the real DOM: fit on load, waiting for `urlRestored`, the
insets changing the framing, ⌥F from a moved camera, and ⌥F ignored while
typing. jsdom lays nothing out, so those tests stub the container's box —
otherwise every fit collapses to `MIN_ZOOM` and passes regardless.

Not tested: the drag handles themselves, consistent with the detail panel's.
