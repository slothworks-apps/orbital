---
id: 2026-09-22-desktop-background-mode-design
title: Desktop background mode — tray, close = hide, guarded quit
type: spec
status: active
domain: desktop
related:
  - 2026-09-16-electron-wrapper-design
  - 2026-09-21-session-autoheal-design
---

# Desktop background mode

The Electron wrapper spec deliberately deferred this: "In the first version,
closing the window quits the app. When the tray item lands, closing becomes
hiding — that is the point at which 'close' and 'quit' have to separate."
This spec is that point. Decided with Tomin, 2026-09-22.

Why it matters: the server is a forked child of the Electron app, so quitting
kills every orbital-run session mid-turn. Closing the window because you are
done *looking* should not be the same act as tearing the workers down.

## Decisions

- **Anchors: menu bar item + Dock.** The app stays a normal Dock app
  (no `LSUIElement`); a tray item is added on top.
- **Tray content: static icon + menu only.** A macOS *template* image
  (monochrome, so the menu bar restyles it for light/dark itself), derived
  from the app icon's silhouette — the one new asset. Menu: **Open Orbital**,
  separator, **Quit Orbital**. No status in the icon, no session list in the
  menu; notifications already carry state changes. Deliberately ruled out:
  needs-input badge (revisit only if notifications prove insufficient).
- **Close = hide.** The red button and ⌘W hide the window; the renderer
  stays alive, so reopening is instant and the map is exactly where it was.
  Chromium suspends `requestAnimationFrame` for hidden windows, so the
  hidden map does not draw; the cost is memory.
- **Quit = ⌘Q or the tray item, guarded.** Quit proceeds silently unless an
  orbital-run session is mid-turn (see below).

## Window lifecycle

- The window's `close` event: when the app is not quitting, `preventDefault()`
  and `hide()`. The window therefore never actually closes in normal use, and
  the `window-all-closed` → `app.quit()` rule is removed outright (macOS is
  the only target; there is no other-platform branch to keep).
- `activate` (Dock click) and the tray's **Open Orbital** both show + focus
  the window. If the window is gone anyway (a crashed renderer), reopen it
  through the existing `openWindow(windowTargetUrl)` — the same URL the
  startup decided on.
- The hide-versus-close decision is a pure function in `desktop/src/lib`
  (pattern: `startup.ts`), taking `{ quitting }` — so the rule is
  vitest-testable without Electron.

## Quit guard

- The main process already consumes the `sessions` topic through
  `sessionsFeed` (notifications). A new pure reducer in `desktop/src/lib`
  folds those frames into the set of sessions with `source === 'web'` and
  `status === 'working'` — the sessions a quit would actually kill.
  Terminal CLI sessions never count: the server's death does not touch them.
  `upsert` adds/removes by the session's current source+status, `remove`
  deletes, and the feed's `onReconnect` resets the set (the world replays).
- `before-quit`: when the server is forked (`forked === true`) and the set is
  non-empty, `preventDefault()` and ask — "N sessions still working — quit
  anyway?" with Quit / Cancel. Quit sets a flag and calls `app.quit()` again;
  the flag lets the second pass through. In attach mode (dev) the guard is
  skipped entirely: the server outlives the app, nothing dies.
- Startup failure paths call `app.quit()` before the feed exists; the set is
  empty then, so those paths stay unblocked by construction.
- The guard decision (`{ forked, workingCount } → 'confirm' | 'quit'`) is a
  pure function beside the reducer, tested the same way.

## What deliberately does not change

- **Notifications.** The "only when Orbital is in the background" rule keys
  off `isFocused()`; a hidden window is not focused, so notifications fire
  while hidden with no change. The click handler already does
  `show()` + `focus()`, which is exactly the reopen path.
- **Server lifecycle.** Quit still kills only the forked child; attach mode
  still owns nothing.
- **`win = null` on `closed`** stays: it now fires only on real teardown,
  which is exactly when the reference is stale.

## Testing

Pure functions only, per the desktop workspace's pattern (`desktop/test`):
the close decision, the quit-guard decision, and the working-set reducer
(upsert/remove/reset transitions). No Electron integration tests; tray
wiring and dialog plumbing are glue.

## Follow-up edit elsewhere

`2026-09-16-electron-wrapper-design.md` § "Closing the window" gets a
one-line pointer to this spec rather than a rewrite — the v1 sentence stays
true as history.
