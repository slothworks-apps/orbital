---
id: 2026-09-23-detached-session-windows-design
title: Detached session windows — a session's detail panel in its own desktop window
type: spec
status: active
domain: desktop
related:
  - 2026-09-16-electron-wrapper-design
  - 2026-09-22-desktop-background-mode-design
  - the-main-process-owns-the-detached-windows
tags:
  - multitasking
---

# Detached session windows

Decided with Tomin, 2026-09-23.

## Why

Orbital exists for multitasking, and the docked detail panel shows one
session at a time. Following two agents at once means switching the
selection back and forth. A session's detail panel can be detached into its
own window, so several sessions sit side by side (on one screen or across
several).

## Decisions

- **Desktop only.** In a plain browser the detach control is not shown.
  Focusing an existing window and closing it are things only Electron does
  reliably; a browser would open a tab and refuse to focus it.
- **One place per session.** A detached session is not shown in the docked
  panel. Detaching closes the docked panel in the main window.
- **Selecting a detached session focuses its window.** The map, the sidebar,
  ⌘K, a notification click and a `?session=<id>` restore all end up there
  rather than opening the docked panel.
- **Closing the window is how a session comes back.** There is no separate
  "dock back" control. After the window closes, selecting the session opens
  the docked panel as before.
- **Detached windows do not survive a quit.** Quit closes them. Nothing about
  them is persisted. Hiding the main window (close = hide) leaves them open.
- **The main process owns the list of detached sessions** — see ADR
  [[the-main-process-owns-the-detached-windows]].

## Behaviour

### Detaching

1. The detach control in the detail panel's header calls the bridge's
   `detachSession(id)`. Look and placement: canvas `Feature - Detached
   window` 22a. It sits in the utility strip beside ×, and the two form a
   pair of their own (stats · pin · clear ‖ detach · close), set tighter than
   the session trio before them. A borderless strip button with the strip's
   states, the tooltip "Open in new window" on hover and on focus, and no
   keyboard shortcut. In a browser the pair is × alone and the strip is
   unchanged.
2. Main opens a window on `/session/<id>`, unless that session already has
   one, in which case it focuses that window instead. At most one window per
   session.
3. Main sends the main window the new list of detached session ids.
4. The main window's store receives the list. The selected session is in
   it, so the selection clears and the docked panel closes — at once, with
   no exit animation: the session moved, it did not close (22a). An ordinary
   close keeps the panel's exit.

### Selecting a detached session

`select(id)` in the store is where every selection lands. When `id` is in
the detached list, it calls the bridge's `focusSession(id)` and selects
nothing.

A notification click is handled in main without a round trip: a detached
session's notification focuses its window, anything else shows the map and
selects the session as today.

### The detached window

- Route `/session/<id>`, a real path. The server's SPA fallback and vite's
  both serve `index.html` for it.
- Renders `DetailPanel` alone, filling the window: no map, no sidebar, no
  resize handle, and the selection is not mirrored into the URL.
- It has its own WebSocket and store: it loads the initial snapshot,
  subscribes to `sessions` and `session:<id>`, and selects `<id>`.
- It never receives the detached list, so its own `select` is never
  redirected to focusing itself.
- It opens at the docked panel's width and a fixed height (constants in
  `desktop/src/main.ts`). It has a minimum width and height and no maximum.
  When it is wider than the docked panel, the transcript reflows.
- Window chrome (22b–22d): a hidden inset title bar. The traffic lights sit
  on the header's row 1, which doubles as the title bar: it drags the window
  (its controls stay clickable), and its left inset clears the lights. The
  panel draws none of its own glass there, so no radius, border, blur,
  bloom or outer inset. The fill is the docked panel's gradient at full
  opacity, and the window's background colour matches it so nothing flashes
  on open.
- The tag-hue glint along the top edge stays, dimmed while the window is
  not focused. Nothing else changes with focus.
- The strip ends at clear: there is no × and no detach control in the
  window. The red traffic light closes it, and so does ⌘W (Electron's
  default menu).
- The window title is the session's title and follows renames.
- A session deleted while its window is open shows the panel's existing
  empty state.

### The subagent panel in the window

Decided with Tomin, 2026-09-23. Before this, `OPEN →` on an agent row in a
detached window set the store's `subagentPanel` and nothing rendered it.

- `OPEN →` opens `SubagentPanel` to the RIGHT of the detail panel, inside
  the same window. The lifecycle is the map's (subagent panel spec § 8
  "Lifecycle"): another agent switches the content, one slot; the panel's ×
  and ⎋ close it; closing the window closes everything.
- **The window grows to make room.** Main widens it to the right by
  `SUBAGENT_PANEL_DEFAULT_PX`, animated. If that would leave the display's
  work area on the right, the window shifts left to stay inside it, and it
  is never wider than the work area.
- **Unless it already fits.** A window at least `WINDOW_PANEL_PAIR_MIN_PX`
  wide (`DETAIL_PANEL_MIN_PX` + `SUBAGENT_PANEL_MIN_PX`; the panels sit
  flush, so there is no gutter) does not grow; the panel opens inside it. A
  full-screen window never grows.
- **Closing gives the room back.** The window narrows by exactly what it
  grew and moves back by whatever it shifted, relative to where it sits now,
  never below its minimum width. If the user resized it while the agent was
  open (its width is no longer the one main set), it is left alone.
- **The width split** (`resolveWindowPanelWidths`): `resolvePanelPairWidths`'
  order without its 75 % ceiling, since there is no map beside the pair to
  keep usable. The subagent panel takes `SUBAGENT_PANEL_DEFAULT_PX` and the
  detail panel the rest. When the rest would be under `DETAIL_PANEL_MIN_PX`,
  the detail panel stops at its minimum and the subagent panel takes what is
  left, down to its own. Below both minimums (only for the moment the window
  is still growing) the overflow is clipped on the right.
- **Separation, provisional until canvas 22f.** No gutter and no glass: both
  panels are chrome-less and flush. Of 11b's cues the subagent panel keeps
  its flatter, darker stops, the inset shadow and hairline on its left edge,
  and its dashed top seam. The chrome lives in one place,
  `subagentWindowChrome` in `web/src/ui/Panel.tsx`.
- **The top band drags the window.** The detail panel's row 1 stays the title
  bar with the traffic-light inset, and the subagent panel's header row
  continues it (`orbital-drag-region`; × stays clickable).
- The main window is unchanged.

The renderer tells main through the bridge's `setSubagentPanel`, IPC
`session-window-subagent`: `{ open: true, widthPx, pairMinPx }` or
`{ open: false }`. The renderer owns the widths, so it sends them; main
validates the payload and honours it only from a detached window, about
itself. The window sends its state on mount as well, so a reload under an
open panel gives back what was grown. Main keeps what each grow did per
window, and a second open while grown keeps the first.

### The session on the map while it is detached

Canvas `Feature - Detached window` 22e.

- The planet stays as it is (live, rings, moons) and gets one badge at the
  body's top-right, outside the rings: the detach glyph on a small dark tile,
  in neutral ink, never the tag hue. The badge keeps a fixed screen size,
  and its offset follows the planet's size.
- Clicking the planet focuses the window, and the badge flashes once.
- When the window closes, the badge fades out and nothing else moves.
- An ended session whose window is still open keeps the badge until the
  window closes.
- The session's sidebar row shows the same glyph after its title, in
  muted, static ink.

### Edge cases

- **Main window hidden:** detached windows stay open. The Dock and the tray
  bring the map back as today.
- **Main renderer rebuilt after a crash:** main sends the detached list again
  once the new page has loaded.
- **"Only when Orbital is in the background":** "in the background" now means
  no Orbital window has focus, not only the main one.
- **Navigation:** a detached window gets the same `setWindowOpenHandler` and
  `will-navigate` rules as the main window. Transcript links open in the
  user's browser.

## Units

### desktop/

- `src/lib/sessionWindows.ts` (new), pure decisions:
  - detach: open a window, or focus the existing one
  - the URL of a session's window
  - which window a notification click targets
  - the `session-window-subagent` payload, and the frame a window takes when
    its subagent panel opens (`growForSubagent`) and closes
    (`shrinkAfterSubagent`)
- `src/main.ts`:
  - `sessionId → BrowserWindow` map and `openSessionWindow`
  - IPC `detach-session`, `focus-session`
  - sends `detached-changed` to the main window when a detached window
    opens or closes, and when the main window finishes loading
  - a detached window really closes on close and leaves the map
  - the background check asks whether any Orbital window has focus
  - IPC `session-window-subagent`, heard only from a detached window, and
    the per-window record of what its grow did
- `src/preload.ts`: `detachSession(id)`, `focusSession(id)`,
  `onDetachedChanged(cb)`, `setSubagentPanel(state)`.

### web/

- `src/lib/desktop.ts`: the three bridge methods, no-ops in a browser, plus
  a way to ask whether the bridge exists (the detach control's visibility).
- Store: `detachedIds`, the redirect in `select`, and a `setDetached(ids)`
  that clears the selection when the selected id is in the new list.
- `src/lib/sessionWindowRoute.ts` (new): the `/session/<id>` parser,
  alongside `parseStatsRoute`. `main.tsx` branches on it.
- `src/SessionWindow.tsx` (new): the data lifecycle above and
  `DetailPanel` in its standalone mode, with `SubagentPanel` beside it when
  an agent is open.
- Store: `resolveWindowPanelWidths` and `WINDOW_PANEL_PAIR_MIN_PX`.
- `SubagentPanel`: an `inWindow` mode (fills the column it is given, window
  chrome, its header row drags the window).
- `DetailPanel`: a standalone mode (fills the window in window chrome, no
  resize handle, no close control, row 1 is the drag region), and the
  detach control. `Panel`'s `fill` carries the window chrome.
- `Planet` (`detached` prop, fed by `SpaceMap`) and `Sidebar`: the badge
  and the row glyph.

## Tests

- The `/session/<id>` parser: empty id, trailing slash, extra segments,
  percent-encoded ids.
- The decisions in `desktop/src/lib/sessionWindows.ts`, including the grow
  and shrink bounds: grow right, shift left at the work area's edge, clamp
  to the work area, no grow when it already fits, shrink back, leave a
  hand-resized window alone, never below the minimum.
- `resolveWindowPanelWidths`: the split and the detail panel yielding
  first.
- Store transitions: `select` on a detached id focuses instead of
  selecting; `setDetached` clears a selection that became detached and
  leaves any other alone.

React rendering of the standalone panel is not tested.

## Out of scope

- Detaching in a plain browser.
- Restoring detached windows after a restart.
- A "dock back" control.
- Detaching anything other than a session's detail panel (the file viewer
  stays inside the panel it belongs to).
