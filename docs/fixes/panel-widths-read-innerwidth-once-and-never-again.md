---
id: panel-widths-read-innerwidth-once-and-never-again
title: The panel pair's widths read window.innerWidth during render and nothing re-reads them on resize
status: done
type: fix
domain: web
related:
  - 2026-09-22-subagent-transcript-panel-design
  - panel-pair-ceiling-includes-the-gutter
  - subagent-panel-width-has-no-drag-handle-yet
tags:
  - web
  - layout
---

# The panel pair's widths read `window.innerWidth` during render and nothing re-reads them on resize

Found by the whole-branch review of `feat/subagent-panel`. Filed rather than
fixed: it predates the subagent panel (every `parse*Width` helper has read
`window.innerWidth` this way since the sidebar got a drag handle), the branch
only added a third caller, and fixing it properly means introducing a
viewport-size source this codebase does not have yet.

## What the bug is

Three call sites compute the detail/subagent pair's widths, each reading the
viewport inline during render:

- `web/src/App.tsx:72-74`
- `web/src/panels/DetailPanel.tsx:208-211`
- `web/src/map/SpaceMap.tsx:509-514`

```ts
const rawDetailPanelWidth = useOrbital((s) => parseDetailPanelWidth(s.settings, window.innerWidth))
const pair = resolvePanelPairWidths(rawDetailPanelWidth, SUBAGENT_PANEL_DEFAULT_PX, window.innerWidth)
```

`window.innerWidth` is not React state and not store state, so nothing
invalidates any of these when the window is resized. The values are
recomputed only when some unrelated re-render happens to occur — a store
write, a hover, a WS message. Until then:

- the 75 % pair ceiling ([[panel-pair-ceiling-includes-the-gutter]]) is
  enforced against the viewport the app last happened to render at;
- shrinking the window can leave both panels wider than the ceiling allows,
  which is exactly the state the ceiling exists to prevent;
- the map's own insets (`mapInsets.right`, `overlayRightPx`) are derived
  from the same stale numbers, so the fit-into-the-gap math disagrees with
  what is actually on screen.

In practice a resize is almost always followed by something else that
re-renders, which is why this has not been noticed.

## Why it is not fixed here

A correct fix is a shared `useViewportWidth()` (a `resize` listener, or a
`ResizeObserver` on the document element, debounced to a frame) feeding all
three call sites — plus `Sidebar.tsx` and `DetailPanel`'s own drag clamps,
which read `innerWidth` the same way. That is a cross-cutting change to how
this app learns its own size, on five call sites, four of which predate the
branch that found it.

## Where to start

`resolvePanelPairWidths` in `web/src/store/store.ts` is already pure and
takes the viewport as an argument, so nothing about the math needs to
change — only where the number comes from. `web/src/test/layout.test.ts`
covers the math; a fix needs a test that a resize actually re-clamps, which
jsdom can drive by dispatching `resize` after setting `window.innerWidth`.

## Fixed 2026-09-24

`web/src/lib/useViewportWidth.ts` is now the one source of the viewport
width: a `resize` listener that commits at most once per animation frame.
`App`, `SessionWindow`, `DetailPanel`, `Sidebar` and `SpaceMap` render from
it, and their drag clamps read the same value. `SessionWindow` and
`DetailPanel` each had a private `useWindowWidth`; both are gone. The pure
width helpers in `store.ts` are unchanged. `app.test.tsx` ("re-clamps the
pair when the window shrinks") shrinks the window under an open pair and
asserts that both panels re-clamp with no store write.

Left on purpose: `ui/usePopupPosition.ts` reads `innerWidth` inside an event
handler, and `SpaceMap`'s fit falls back to `innerWidth`/`innerHeight` only
when its container has no rect yet. Neither of them is a render-time read
that goes stale.
