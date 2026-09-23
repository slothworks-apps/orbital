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

## ⌘1

A new menu item, Window → Map (⌘1), shows and focuses the main window. It
works from any Orbital window, including a detached one. The application menu
keeps macOS's defaults (⌘W, ⌘M, Edit, etc.).

## Tests

Pure logic only: the crumb list per route, the ⌘[ target per route, the
truncation order if it is computed rather than CSS-driven, and the bridge
message parsing for opening a path in the main window.

## Implementation notes

Recorded while building the bar, 2026-09-24.

- **One component, one list.** `web/src/ui/PageBar.tsx` draws the bar and
  owns esc and ⌘[; `web/src/lib/pageCrumbs.ts` turns the page into its crumbs,
  and the ⌘[ target (the parent crumb) and `document.title` are read off the
  same list. A page can take over a crumb's navigation by its key: the
  walkthrough's cover is page state, not a path, so WALKTHROUGH and ⌘[ go
  there without a reload; the drilldown's STATS goes back through history when
  the feed is the previous entry, which is what keeps the findings' scroll.
  A modified click still follows the crumb's real href.
- **esc goes to the map itself, `/`**, with no session selected; the session
  crumb (and ⌘[ from the cover) is the way to the map with the session's
  panel open (25h). The walkthrough's esc used to select the session.
- **An open overlay** registered with the escape-layer stack takes esc first.
  A focused text field only lets go of the focus; the next esc goes to the
  map. ⌘[ works with either open.
- **Titles.** The cover is `<session> · Walkthrough · Orbital`, the close
  screen `close · <session> · Orbital` (its crumb reads `close`).
- **The drilldown reads the session's row** (`GET /api/sessions/<id>`) for the
  tag dot, path and status chip; the stats endpoint carries none of them. A
  session Orbital does not know gets its crumbs and esc only. Until the stats
  answer, the session crumb reads the head of the uuid.
- **Status chip** is the canvas's resting chip in every state; the dot blinks
  while the session works, as the walkthrough's pill did (21a).
- **"session working · steps may be added"** stays, as plain text ahead of
  the path. It shortens after the session crumb and before the path.
- **The stats content's left edge follows the mark** (25b, 25f), so it moves
  with the bar between windowed and full screen.
- **The walkthrough rail.** 25d/25e draw the rail at a mock width; the real
  rail (21b) keeps its width in full screen and in the browser, and windowed
  it widens on its left by exactly as much as the mark moves right, so the
  list keeps its width and its left edge follows the mark.
- **Tooltips are native `title`s**, as the canvas draws them. `ui/Tooltip`
  claims esc while it is open from the keyboard, which would make the esc
  button's first press dismiss its own tooltip.
