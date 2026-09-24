---
id: desktop-startup-window-and-updates
title: Remember the window's size, place and URL between launches — the main window and the detached ones
status: backlog
type: idea
domain: desktop
related:
  - 2026-09-21-settings-sections-design
  - 2026-09-16-electron-wrapper-design
  - 2026-09-22-desktop-background-mode-design
  - 2026-09-23-detached-session-windows-design
  - the-main-process-owns-the-detached-windows
tags:
  - desktop
  - settings
---
# Remember the window's size, place and URL between launches

> **Narrowed 2026-09-24** by Tomin. Of the four rows below, one is done (the
> tray), one is not wanted now (login item), one is ruled out (the updater),
> and one is cut down to what actually hurts: the main window opens at its
> default size on every launch and has to be enlarged by hand, and every
> detached session window opens at the fixed default too. What is wanted:
>
> - the **main window** remembers its size and position, and the URL it was
>   on, and comes back to them on the next launch;
> - a **detached session window** remembers the size and position the last
>   one was left at, and the next one opens there (assumption: one remembered
>   frame for all detached windows, not one per session);
> - nothing about the camera — zoom and pan are not part of it.
>
> The main process owns the windows ([[the-main-process-owns-the-detached-windows]]),
> so it is the natural place to store the frames, in its own file under
> Electron's user-data directory rather than in the server's settings table.
> The rows below are the original survey, kept for the reasoning.

## The original four rows

`General` in [[2026-09-21-settings-sections-design]] has a `STARTUP &
WINDOW` group in its target shape and ships without it, because none of the
behaviour behind it exists. `grep -rn "Tray\|autoUpdater\|setLoginItem"
desktop/src` returns nothing: the main process forks the server, opens one
window, and that is the whole lifecycle.

Four rows are waiting on four separate pieces of work.

~~**Launch Orbital at login**~~ — **not now** (Tomin, 2026-09-24). It is the cheap one —
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

**Restore the last view on start** — narrowed to the frame and the URL above; the camera is out. The rest of this row is the original reasoning. It needs the view to be storable at all.
The selected session already lives in the URL query
([[selected-session-lives-in-the-url-query]]) and the sidebar's width
persists through the settings table, but camera zoom and pan do not persist
anywhere, and [[sidebar-collapsed-state-should-survive-reload]] is the same
complaint one level down. Doing that one first makes this one small.

~~**Check for updates automatically**~~ — **ruled out** (Tomin, 2026-09-24): it needs a place to publish to and a check on every launch, which is a lot of surface for a tool used by one person and a few colleagues; a new DMG is shared by hand. The original note: it means adopting `electron-updater` and a
place to publish to, which is a packaging decision more than a UI one —
`trim-and-sign-the-desktop-package` is the neighbour it should be settled
with.

None of these block the settings redivide. They are the reason `General`
ships with two groups instead of three.
