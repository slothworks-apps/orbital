---
id: more-than-one-session-open
title: Keep more than one session open at a time
status: superseded
type: idea
domain: web
related:
  - 2026-09-23-detached-session-windows-design
  - selected-session-lives-in-the-url-query
  - resizable-detail-panel
  - desktop-wrapper-electron
tags:
  - detail-panel
  - space-map
---
# Keep more than one session open at a time

> **Superseded 2026-09-24** by [[2026-09-23-detached-session-windows-design]]:
> a session opens in its own desktop window, so several can be watched at
> once, each with its own transcript stream. The docked panel stays single.

One session is open at a time, so watching a long run means either sitting on
it or losing its transcript stream the moment you look at anything else.

## Most of the store is already ready

`transcripts`, `usage` and `historyLoaded` are all keyed by session id, and
`select()` fetches a session's history once regardless of how often it is
selected. Several sessions can coexist in the store today. The WS client is
refcounted per topic, so several live `session:<id>` subscriptions are a
supported case rather than a change.

What is singular is small and specific:

- `ui.selectedId` — one id.
- `App`'s `session:<id>` effect, whose dependency + cleanup *is* the
  "subscribe to the new one, unsubscribe the old one" behaviour.
- `DetailPanel`, which renders that id (and holds `lastId` so the outgoing
  session survives its exit animation).
- The URL's single `?session=` ([[selected-session-lives-in-the-url-query]]).
- `SpaceMap`, which follows one planet.

  (Written when the map reserved a fixed `DETAIL_PANEL_PX` on the right. That
  constant is gone: `resizable-detail-panel` shipped and
  `2026-09-21-fit-honours-the-panels-design` made `centerOn`/`fitView` take
  real `Insets`. So this bullet is no longer part of what stands in the way —
  see shape 2 below.)

## Three shapes, in the order worth building

1. **Tabs in the one panel.** `selectedId` becomes `openIds` + `activeId`; the
   panel keeps its whole layout and grows a tab strip; the map still follows
   the active planet, so the camera code is untouched. Cheapest, and every
   other option needs this same state change first.
2. **Two panels side by side.** Probably what the wish actually means — watch
   one work while typing into another. It costs the map its space, which used
   to make [[resizable-detail-panel]] and real camera insets a prerequisite —
   both have since shipped, so this shape is cheaper than it reads here.
3. **Separate windows.** Only after [[desktop-wrapper-electron]]; each window
   is another renderer with its own socket and store. Most freedom, most cost.

**Start at 1 and treat 2 as rendering two of them.**

## What has to hold either way

- **Every open session streams.** Today only the selected one does. With N
  open, N subscriptions run and N transcripts grow — `MAX_VISIBLE_MESSAGES`
  is 200 *per session*, and nothing evicts a transcript when its session is
  closed. Closing a tab should drop its transcript, or a long day of tab-
  opening is a slow leak.
- **The map has to show what is open.** One planet is active; the others
  should still read as open rather than vanishing from the map's point of
  view. This is unspecified by the design: artboards 1a–1h draw exactly one
  detail panel, there is no tab strip and no split anywhere on the canvas.
  Decide the look there before building it.
- **Escape and the URL.** Escape clears the single selection today; with a set
  it should close the active one. And the URL needs a decision — the active id
  only, or the whole set, which is what would let a reopened window restore
  the workspace rather than one session.
- **Attribution.** A toast or a `needs_input` badge is unambiguous while one
  session is open. With several, both have to name which.
