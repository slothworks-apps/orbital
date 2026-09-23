---
id: 2026-09-24-main-window-chrome-design
title: Main window chrome — no grey title bar, a top drag band, lights in the sidebar
type: spec
status: active
domain: desktop
related:
  - 2026-09-16-electron-wrapper-design
  - 2026-09-23-detached-session-windows-design
  - 2026-09-21-fit-honours-the-panels-design
---

# Main window chrome

Decided with Tomin, 2026-09-24. Design: canvas `Feature - Main window
chrome` 24a–24g. Where this and the canvas disagree on a pixel, the canvas
wins; where they disagree on behaviour, this document records the decision.

## Why

The main window still wears macOS's grey title bar reading "Orbital", which
the detached session windows (22b) already dropped. The map should run to the
top edge, as it does in the detached window.

## Decisions

- **Desktop only, macOS.** The browser build does not change.
- **`titleBarStyle: 'hiddenInset'`** on the main window. The window title
  stays "Orbital" for Mission Control, the Dock and ⌘`.
- **The drag region is the whole top band**, full width, from the top edge to
  just below the HUD row (canvas: 48 px), in every windowed state. Controls
  inside it stay clickable (no-drag): « in sidebar row 1, the detail panel's
  row-1 buttons and its title field, anything else interactive. The HUD's
  aggregate readout is plain text since tag clusters (ENDED is no longer a
  toggle), so it drags. Double-clicking the band runs the system title-bar
  action (zoom by default).
- **The map does not pan in the band**, and camera fit keeps it clear (top
  padding grows by the band's height). A planet panned under the band does
  not respond there.
- **A hint marks the band** (24g): a gradient from the top edge, no hairline,
  no hover state.
- **Traffic lights: expanded sidebar only.** With the sidebar expanded they
  sit in its row 1 (`trafficLightPosition`, 24a), and row 1's padding makes
  room for them. Collapsed, they are hidden
  (`setWindowButtonVisibility(false)`) and the rail keeps today's geometry
  (24b). ⌘W, ⌘M and the Window menu still work. The lights hide at the START
  of the collapse and show at the END of the expand: in between they would
  overhang the narrowing rail.
- **Full screen:** no lights, no drag band, no hint, camera fit back to its
  usual top padding, and row 1 has today's padding (24c). The switch happens
  on Electron's enter/leave full-screen events, pushed to the renderer, in the
  same frame.
- **Inactive window:** lights go grey (macOS does that), the Orbital mark
  drops to 45 % (24d). Nothing else dims.
- **Overlays over a drag region are no-drag.** Electron computes drag regions
  from the DOM without regard to stacking, so a dialog lying over the band
  would move the window instead of taking the click. Dialog and popover
  overlays opt out. The detached window has the same exposure over its row 1
  and gets the same fix.

## Units

- `desktop/src/main.ts`: `hiddenInset`, `trafficLightPosition` for the main
  window; IPC for light visibility (renderer → main) and full-screen state
  (main → renderer, also sent on load).
- `desktop/src/preload.ts`, `web/src/lib/desktop.ts`: the bridge for both.
- `web/`: the band (drag + hint), sidebar row 1 padding and mark opacity,
  camera fit's top inset, the no-drag overlays; all gated on the desktop
  bridge and on not being full screen.

## Tests

Pure logic only: camera fit's top inset with and without the band, and any
decision function for when the lights show.

## Implementation notes

Recorded while building it, 2026-09-24.

- **How the band is built.** One transparent element across the top
  (`.orbital-window-band`, `WINDOW_DRAG_BAND_PX` tall), first among the
  chrome in the DOM, above the HUD and under the panels. Electron adds drag
  boxes and cuts no-drag boxes in document order, whatever the stacking, so
  what lies over the band and must stay clickable says no-drag:
  `.orbital-band-controls` on the containers whose controls sit in the band
  (sidebar row 1 and the rail — only the layer on show, since the faded one
  keeps its boxes — the detail and subagent headers), and `.orbital-no-drag`
  on the resize handles and on every dialog backdrop and popover root (the
  latter in both kinds of window).
- **The hint sits under the HUD**, over the map and its labels. The
  aggregate readout in the band is not darkened by it.
- **Fit's top padding** is the band plus `FIT_MARGIN_PX.top`, which is what
  fit already kept clear of the top edge before (not the HUD's 24 px offset).
- **Lights and full screen.** Main keeps the last request from the sidebar
  and applies it only out of full screen, including on the way out. A new
  page load (not an in-page navigation) resets the lights to shown, because
  the page that replaces the map may have no sidebar to ask for them back.
- **Open: other pages in the main window.** `/stats` and `/walkthrough/<id>`
  load in the main window too, and they draw no band: under `hiddenInset`
  their top edge does not drag the window and the lights sit over their top
  left. Needs a canvas decision; until then those pages are as they render.
