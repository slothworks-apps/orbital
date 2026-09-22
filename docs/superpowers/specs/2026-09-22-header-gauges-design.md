---
id: 2026-09-22-header-gauges-design
title: Header gauges — two bars, one width, and an off switch
status: done
type: spec
domain: web
related:
  - 2026-09-20-session-stats-design
  - context-fill-arc
  - the-stats-row-reads-when-the-stats-are-written
tags:
  - web
  - stats
---
# Header gauges — two bars, one width, and an off switch

Canvas: `Feature - Header gauges.dc.html`, artboards 11a–11d. The brief
in that file is marked `DECIDED · A + SETTING`; where this spec and the
canvas disagree, the canvas wins.

## The problem (11a)

The detail-panel header ended up carrying two horizontal bars: the
context gauge, flush with the header's own padding, and the session
stats split, inset by the chip it was drawn inside. At a 450 px panel
that is 404 px against 376 px — close enough that the eye reads a broken
grid rather than two different objects. Both are progress-shaped and
both are the panel's only horizontals, so they get compared whether we
want it or not.

## What changed

### 1. The stats strip loses its chip (11b, variant A)

`SessionStatsRow`'s shell is now a hairline and 13 px of top padding
instead of a rounded box with 13 px of horizontal padding and a border.
Both bars now run to the same left and right edge.

The chip was also the "this is a button" cue, so the press affordance
moves onto the hairline: it lifts from `rgba(150,205,255,.1)` to `.22`
on hover and on focus, alongside the chevron the content already
brightens. The background fill and the glow the chip carried are gone —
a full-width tint reads as a band, not as a control.

Variants B (context gauge into a matching chip) and C (both readouts in
one card) were drawn and ruled out on the canvas: both grow the header
by 13–20 px, and C merges two unrelated readouts into one object.

### 2. The row gets an off switch (11c)

New setting `header_session_stats`, stored server-side in
`DEFAULT_SETTINGS` and read through `headerSessionStats()` in the web
store. Two positions:

- `bar` (default) — the strip as above.
- `button` — no strip at all. Stats becomes the first icon in the
  header's utility row (stats · pin · clear · close, close staying
  last), drawn as three bottom-aligned bars with no axis and no frame.
  The transcript gains the 42 px.

Per install, not per session: it is a preference about how a header is
drawn, and both positions keep the same click target and the same
`QuickStatsDialog` behind it. Anything other than the literal `button`
draws the bar, so a value from a future build cannot empty the header of
its only readout.

The icon's states come from 11c's ICON · STATES: resting and hover are
`UtilityButton`'s own, dialog-open is its `active` fill, LIVE adds the
pulsing dot the strip already carried, and NO DATA is simply a disabled
button — a session with no measured turn has nothing to open. Since the
numbers leave the header in this mode, the control's name carries them:
`Session stats — 2h 22m, $167.30`, as both `aria-label` and `title`.

Settings → Appearance → DETAIL PANEL holds the two-position control.

### 3. `/stats` gains an app-level entry (11d)

Before this, the stats dashboard could only be reached by opening a
session. The sidebar footer is already the app-level strip — a session
count and the only global button — so the second app-level destination
goes beside the first, as an icon-only link to `/stats` immediately
before SETTINGS. The collapsed rail gets the same glyph in its icon
column, above the session dots.

Icon only: the pair then reads as utilities, and the word SETTINGS keeps
its weight. The glyph is the header's, at 10×9 in the footer and 12×11
in the rail.

11d also asks for an active state while `/stats` is the current route.
That state is unreachable and is not implemented: `main.tsx` branches on
the pathname before `App` renders, so `/stats` replaces the whole app and
this sidebar is never on screen while that route is current.

## Where it lives

| what | file |
|---|---|
| the setting's default | `server/src/db/database.ts` |
| reading the setting | `headerSessionStats` in `web/src/store/store.ts` |
| both shapes of the readout | `web/src/panels/SessionStatsRow.tsx` |
| placing them in the header | `web/src/panels/DetailPanel.tsx` |
| the glyph, at both sizes | `StatsGlyph` in `web/src/ui/UtilityButton.tsx` |
| the control | Appearance → DETAIL PANEL, `web/src/panels/Settings.tsx` |
| the `/stats` entry | `StatsLink` in `web/src/panels/Sidebar.tsx` |

## Out of scope

Title, path, the tag / model / permission row, and the dialog behind the
stats trigger are untouched. Terminal sessions have no context gauge and
never did; button-only leaves their header at title + path + the icon
strip, which is what 11c asks for.
