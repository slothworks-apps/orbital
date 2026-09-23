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
   `detachSession(id)`. Its placement and look come from Claude Design.
2. Main opens a window on `/session/<id>`, unless that session already has
   one, in which case it focuses that window instead. At most one window per
   session.
3. Main sends the main window the new list of detached session ids.
4. The main window's store receives the list. The selected session is in
   it, so the selection clears and the docked panel closes.

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
- The panel's close control closes the window.
- The window title is the session's title and follows renames.
- A session deleted while its window is open shows the panel's existing
  empty state.

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
- `src/main.ts`:
  - `sessionId → BrowserWindow` map and `openSessionWindow`
  - IPC `detach-session`, `focus-session`
  - sends `detached-changed` to the main window when a detached window
    opens or closes, and when the main window finishes loading
  - a detached window really closes on close and leaves the map
  - the background check asks whether any Orbital window has focus
- `src/preload.ts`: `detachSession(id)`, `focusSession(id)`,
  `onDetachedChanged(cb)`.

### web/

- `src/lib/desktop.ts`: the three bridge methods, no-ops in a browser, plus
  a way to ask whether the bridge exists (the detach control's visibility).
- Store: `detachedIds`, the redirect in `select`, and a `setDetached(ids)`
  that clears the selection when the selected id is in the new list.
- `src/lib/sessionWindowRoute.ts` (new): the `/session/<id>` parser,
  alongside `parseStatsRoute`. `main.tsx` branches on it.
- `src/SessionWindow.tsx` (new): the data lifecycle above and
  `DetailPanel` in its standalone mode.
- `DetailPanel`: a standalone mode (fills the window, no resize handle,
  close = `window.close()`), and the detach control.

## Tests

- The `/session/<id>` parser: empty id, trailing slash, extra segments,
  percent-encoded ids.
- The decisions in `desktop/src/lib/sessionWindows.ts`.
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
