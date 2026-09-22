---
id: desktop-startup-window-and-updates
title: The desktop shell has no tray, no login item and no updater
status: backlog
type: idea
domain: desktop
related:
  - 2026-09-21-settings-sections-design
  - 2026-09-16-electron-wrapper-design
  - 2026-09-22-desktop-background-mode-design
tags:
  - desktop
  - settings
---
# The desktop shell has no tray, no login item and no updater

`General` in [[2026-09-21-settings-sections-design]] has a `STARTUP &
WINDOW` group in its target shape and ships without it, because none of the
behaviour behind it exists. `grep -rn "Tray\|autoUpdater\|setLoginItem"
desktop/src` returns nothing: the main process forks the server, opens one
window, and that is the whole lifecycle.

Four rows are waiting on four separate pieces of work.

**Launch Orbital at login** is the cheap one —
`app.setLoginItemSettings({ openAtLogin })`, read back on open so the row
reflects what macOS actually holds rather than what we last wrote. Worth
doing first; it is the row most aligned with what Orbital is for, since a
map of running sessions is only useful if it is already running.

~~**Closing the window keeps Orbital in the menu bar**~~ — **picked up.**
Specced as [[2026-09-22-desktop-background-mode-design]] (tray, close = hide,
guarded quit) and in build. The open question this row raised — what the tray
icon says when three sessions need input — was answered there and ruled out:
static template icon, no badge, because notifications already carry state
changes.

**Restore the last view on start** needs the view to be storable at all.
The selected session already lives in the URL query
([[selected-session-lives-in-the-url-query]]) and the sidebar's width
persists through the settings table, but camera zoom and pan do not persist
anywhere, and [[sidebar-collapsed-state-should-survive-reload]] is the same
complaint one level down. Doing that one first makes this one small.

**Check for updates automatically** means adopting `electron-updater` and a
place to publish to, which is a packaging decision more than a UI one —
`trim-and-sign-the-desktop-package` is the neighbour it should be settled
with.

None of these block the settings redivide. They are the reason `General`
ships with two groups instead of three.
