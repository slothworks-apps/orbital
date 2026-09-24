---
id: 2026-09-24-remembered-window-frames-design
title: "The desktop windows come back where they were left: the main window's frame and page, and one frame for detached windows"
type: spec
status: done
domain: desktop
related:
  - desktop-startup-window-and-updates
  - the-main-process-owns-the-detached-windows
  - 2026-09-23-detached-session-windows-design
  - 2026-09-16-electron-wrapper-design
tags:
  - desktop
---

# The desktop windows come back where they were left

The narrowed [[desktop-startup-window-and-updates]]: the main window opened at
its default size on every launch, and every detached session window opened at
the fixed default too. Nothing about the camera is part of this.

## 1. Behaviour

- **Main window.** It opens at the frame it was last left at and loads the
  in-app page it was last on — the map with its `?session=` and file
  parameters, `/stats` with its filters, a walkthrough. With no remembered
  frame it opens at the default size, centred; with no remembered page it
  opens on the map.
- **A page that no longer resolves** is the page's own business, as it is on
  a refresh: an unknown `?session=` is dropped and nothing is selected, a
  missing walkthrough says so, and every page has the bar back to the map.
  Main never loads the detached window's route (`/session/<id>`) into the
  main window, and never a path that would leave the origin.
- **Detached windows** share one remembered frame: the one the last detached
  window was moved or resized to. That includes the grow and shrink for the
  subagent panel, since those are resizes. A new detached window opens there;
  with nothing remembered it opens at the default size, centred on the
  primary display.
- **Several detached windows.** Every new one starts from the same frame, so
  while an open detached window has exactly the same top-left corner, the new
  one steps down and to the right by `SESSION_WINDOW_CASCADE_STEP`. Only an
  exact corner match counts; the steps stop at the work area's edge and are
  bounded by the number of open windows, so at the edge one may land on
  another.
- **What a detached window remembers.** Only a move or a resize is taken. The
  frame a window opened at is not: a cascade step is not the user's choice,
  and taking it on close would walk the remembered frame down the screen one
  step for every untouched window.
- **Displays.** A remembered frame goes back to the display whose work area
  it overlaps most, and is shrunk and moved just enough to sit wholly inside
  it. A frame on a display that is no longer connected is centred on the
  primary display at its remembered size (shrunk to fit).
- **Full screen and zoom** are not remembered: the frame written is the
  window's normal frame, so a window left in full screen comes back at the
  size it had before it.
- **Crash rebuild.** A main window rebuilt after a renderer crash uses the
  remembered frame too, and loads the URL startup chose, as before.

## 2. The file

`window-frames.json` in Electron's `userData` directory (so the packaged app
and an unpackaged `electron .` each have their own). Main is its only reader
and writer: it reads it once at launch and keeps the copy in memory.

```json
{
  "version": 1,
  "main": {
    "bounds": { "x": 120, "y": 90, "width": 1440, "height": 900 },
    "path": "/stats?range=7d"
  },
  "session": { "x": 300, "y": 120, "width": 450, "height": 820 }
}
```

- Frames are in screen points (DIP), whole numbers, positive size.
- `path` is path, query and hash only. The origin is not stored: startup may
  choose the server's origin or vite's, and the path means the same page on
  either.
- Read defensively: a missing file, bad JSON or another `version` means
  nothing is remembered. Each part is dropped on its own — a bad `path` costs
  the path, not the frame beside it.
- Written on move and resize after they settle (`FRAME_WRITE_DELAY_MS`), on
  every page change in the main window, at once when the main window hides or
  closes, when a detached window closes, and on quit. Written through a
  temporary file and a rename; a failed write is logged and costs nothing
  else.

## 3. Units

- `desktop/src/lib/windowFrames.ts` — every decision: parsing the file,
  which paths may be restored, whether anything changed, fitting a frame to
  the displays, the cascade. Tested in `desktop/test/windowFrames.test.ts`.
- `desktop/src/main.ts` — reads and writes the file, passes the displays'
  work areas in, and wires window events to the functions above.

## Out of scope

The camera (zoom, pan), a frame per session, remembering full screen, and a
setting to turn any of this off.
