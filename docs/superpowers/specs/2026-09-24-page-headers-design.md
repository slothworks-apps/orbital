---
id: 2026-09-24-page-headers-design
title: Page headers — one bar for the sub-pages, esc to the map, ⌘1
type: spec
status: active
domain: web
related:
  - 2026-09-24-main-window-chrome-design
  - 2026-09-23-detached-session-windows-design
  - 2026-09-23-walkthrough-design
---

# Page headers

Decided with Tomin, 2026-09-24. Design: canvas `Feature - Page headers`
25a–25j. Where this and the canvas disagree on a pixel, the canvas wins;
where they disagree on behaviour, this document records the decision.

## Why

The sub-pages that load in the main window — `/stats`, `/stats/session/<id>`
and `/walkthrough/<id>` — each had their own header and their own way back
(`MAP`, `← back to findings`, `← <session>`, 21e's `← Back to the map`).
Under the main window's hidden title bar (spec
[[2026-09-24-main-window-chrome-design]]) none of them made room for the
traffic lights or dragged the window.

## Scope

- In: the headers of `/stats` (10a), the drilldown, and the walkthrough's
  cover, steps and close screen (21a–e); the keys; window titles; opening a
  walkthrough from a detached window; ⌘1.
- Unchanged: the map (24a–24g) is the reference, not a subject. The detached
  window (22b) keeps its row 1; 25i lists which rules it already follows.

## The bar

- One component for all three pages. Left: breadcrumb. Right, in this fixed
  order: path · status chip · esc.
- **Windowed desktop:** 64 px tall, row centred on the lights' line, the left
  reserved for the lights, the Orbital mark at the same point as the map's
  sidebar row 1. The **whole bar drags the window**; the crumbs, the status
  chip and esc are no-drag, the path and empty space drag. Double-click
  zooms.
- **Full screen and browser:** 56 px, no lights reserve, no drag.
- **Sticky.** Content scrolls under it. At rest on `/stats` and the
  drilldown it wears the map's band gradient and no hairline; once content
  scrolls under it, a fill, blur and hairline appear. The walkthrough, whose
  columns start under the bar, always has its fill and hairline.

## Breadcrumbs

- `ORBITAL / STATS`, `ORBITAL / STATS / <session>`,
  `ORBITAL / <session> / WALKTHROUGH / <step>`.
- Every crumb but the last is a real link. ORBITAL goes to the map; a session
  crumb goes to the map with that session's detail panel open; WALKTHROUGH
  goes to the cover.
- A session crumb carries its tag dot.
- Truncation: the session crumb shortens first, then the path. The status
  chip and esc never shorten.

## Keys and the esc button

- **esc goes to the map, in one press, from every sub-page and every
  walkthrough step.** If an overlay is open, esc closes it and stops.
- **⌘[ goes up one crumb** (the crumb's shortcut): drilldown → `/stats` with
  the findings scroll kept; walkthrough step or close → cover; cover → map
  with the session's panel open; `/stats` → map. There is no ⌘].
- **The esc button** (`× ESC`) is the last item on the right of every
  sub-page, no-drag, and does what esc does. It replaces the MAP · STATS
  switch (removed) and 21e's `← Back to the map` (removed). No text label at
  any width.
- The browser's own back button keeps real history; Orbital does not touch
  it.

## Window titles

`document.title` follows the deepest crumb first: `Stats · Orbital`,
`<session> · Stats · Orbital`, `step <n> · <session> · Orbital`. The main
window's native title stays "Orbital" (main window chrome spec) — only the
document title changes.

## Walkthrough from a detached window

The walkthrough control in a detached window's strip no longer navigates that
window. It asks main, over the bridge, to load the walkthrough in the main
window and bring the main window forward. The detached window stays as it
was.

- The message is `open-in-main-window` with an in-app path. Main lets only
  `/walkthrough/<id>` through — the id one encoded segment, never `.` or
  `..` — and loads it on the origin startup chose, as it builds a detached
  window's URL. Anything else is dropped.
- A hidden main window is shown; a missing one (crashed renderer) is rebuilt
  on the walkthrough, while startup's URL stays the one a server restart
  reloads.
- In a browser a `/session/<id>` page has no bridge to ask through, so the
  control is not offered there. The main window's control navigates itself,
  as before.

## ⌘1

A new menu item, Window → Map (⌘1), shows and focuses the main window. It
works from any Orbital window, including a detached one. The application menu
keeps macOS's defaults (⌘W, ⌘M, Edit, etc.).

- The menu is Orbital's own, so it restates the defaults by role: the app
  menu (Quit goes through the quit guard), File (Close Window), Edit (what
  makes ⌘C/⌘V work in inputs), View and Window. Window uses the `window` role
  so macOS keeps the window list and ⌘`.
- View keeps reload and zoom in the packaged app, as Electron's default did;
  the developer tools are there only in development. Electron's default Help
  menu, which linked to Electron's own site, is gone.
- Map before startup has chosen a URL does nothing, as the Dock icon does.

## Tests

Pure logic only: the crumb list per route, the ⌘[ target per route, the
truncation order if it is computed rather than CSS-driven, and the bridge
message parsing for opening a path in the main window.
