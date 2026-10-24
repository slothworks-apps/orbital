---
id: 2026-10-24-session-context-menu-design
title: Session context menu on the map and in the sidebar
type: spec
status: active
domain: web
related:
  - 2026-10-05-mobile-next-design
tags:
  - map
  - sidebar
  - ui
---

# Session context menu on the map and in the sidebar

A right-click on a planet, or on a session's row in the left sidebar, opens a
menu of what can be done with that session — at the pointer, without opening
the session first. Today every one of those actions needs the session opened
and its header found: pinning a planet means select, find the pin; clearing
means select, open the header's ⋯, pick Clear. With several sessions running,
those detours are the overhead Orbital exists to cut.

## Scope

- **Who it is for:** everyone on the desktop app (and the browser build),
  most of all someone with many sessions on the map.
- **Where it lives:** on by default. It takes nothing away and puts nothing
  new on screen until someone right-clicks; no Labs.
- **What someone already using Orbital notices after updating:** nothing,
  until they right-click a planet or a row. Left-click, drag, hover and the
  header's ⋯ menu behave as before. In the browser build, the menu takes
  the place of the browser's own right-click menu on planets, Desk cards and
  sidebar rows; everywhere else the browser's menu is as it was.
- **What can be set:** nothing. No setting to turn it off — it is invisible
  until asked for.

## Where it opens

| target | menu |
|---|---|
| a planet on the map (its body and its label, the same hit area a click uses) | the session menu |
| the same session in the Desk theme's card | the session menu |
| a session's row in the sidebar, pinned list included | the session menu |
| a moon, empty map, the sun, a tag chip, anywhere else | nothing; the browser's own menu stays suppressed where it already is |

The moon menu and an empty-map menu are left out of the first version
(builder's call recorded here: neither had an action that is missing today).

## Behaviour

- `contextmenu` opens it, so ctrl+click on a Mac opens it too. The event's
  default is prevented only on the targets above; text fields keep theirs.
- It opens at the pointer and stays inside the window (the existing popup
  positioning flips it at the edges).
- Opening it **does not select the session**, does not move the camera, and
  does not open the detail panel. Only an item that is about opening does.
- While it is open the map does not pan or zoom under it; the planet keeps
  its hover look so it is clear which session the menu is about.
- Escape, a click outside, or choosing an item closes it. A right-click on
  another planet or row while it is open moves it there for that session.
- Keyboard inside the open menu works as in the existing `Menu` (arrows,
  type-ahead, Enter). Opening it from the keyboard is not part of this.

## The session menu

Three groups, in this order — the phone's ⋯ sheet's order (reversible
first, deliberate last), with the desktop's openings in front:

1. **Open** · **Open in new window** (where the header offers it today)
2. **Rename…** · **Regenerate name** · **Change tag** · **Pin** / **Unpin** ·
   **Copy path**
3. **Take over** (a terminal session the Mac can take over) ·
   **Clear and start over…** · **End session…**

Which items a session gets follows the phone's rules, not a second set of
them: `menuFor` in `web/src/mobile/menu/sessionMenu.ts` already decides
rename / tag / pin for every session, clear and end only for an Orbital
session (end only while it has not ended), take over only for a terminal one
the Mac serves. Move that function to `web/src/lib` and use it from both;
the desktop adds its own openings, Regenerate name and Copy path around it.
A terminal session therefore gets no Clear and no End — it is shown, not
driven.

What each item does — every one reuses what the app already does, none is
new behaviour:

- **Open** — what a left-click does.
- **Open in new window** — the header ⋯'s Open in new window.
- **Rename…** — selects the session and puts its title in the header into
  edit mode, as clicking the title does. The one item besides the openings
  that selects: the title is edited where it is shown.
- **Regenerate name** — the header's regenerate action, without selecting.
  Which sessions are being renamed moves from `DetailPanel` to the store,
  so the spinner shows in the header whenever that session is opened, and
  on its sidebar row if the canvas gives the row one.
- **Change tag** — the tag list replaces the menu's rows in place, with a
  way back, as the phone's sheet swaps to its tag view. `Menu` has no
  submenus, and one level of swap is enough. Picking a tag sets it the way
  the header's tag chip does (optimistic, rolled back with an error line).
- **Pin / Unpin** — the store's `setSessionPinned`.
- **Copy path** — the session's working directory to the clipboard
  (`web/src/lib/clipboard.ts`). The menu closes; there is no shared copy
  receipt in the app today, so none is drawn until the canvas asks for one.
- **Take over** — the desktop's existing Take over dialog, under the same
  condition the header offers it.
- **Clear and start over…** / **End session…** — the existing `ClearDialog`
  / `EndDialog`, and Clear keeps the header's rule: with "don't ask again"
  set it clears at once, as the header does; afterwards the new session is
  selected, as after the header's Clear.

**Dialogs open over the map, without selecting the session** (the
maintainer's choice). `SpaceMap` already mounts an `EndDialog` for any
session; `ClearDialog` and `TakeOverDialog` move up out of `DetailPanel` the
same way, so one mount serves the header and the context menu alike, and
the selection does not change under the dialog.
As built, that one mount is `SessionDialogs`, beside the app's other dialogs
in `App` (and in the detached window), not inside `SpaceMap`: the sidebar and
the Desk theme open the menu too, and neither lives in `SpaceMap`. The
trash's own End confirm stays in `SpaceMap`, since it ends the trash's way.

A session on another device whose machine is offline keeps its menu: Open
and Copy path still work (they need nothing from that machine), every other
item is drawn but inert, so the menu still shows what it would offer.

## How it is built

- One `ContextMenu` in `web/src/ui` on top of `Menu.tsx`: same rows, keys,
  escape layer and popup positioning, anchored to a point instead of a
  trigger button. Do not fork `Menu`'s row rendering.
- One function that builds the session's `MenuEntry[]`, used by the map, the
  Desk card and the sidebar row. The header ⋯ menu keeps its own items
  (stats, harness, clear, detach) — it is about the open session, this is
  about any session.
- On the map the right-click comes from the same r3f pointer handling that
  carries the planet's click; a right-button press must not start a pan.
- The site's demos render map components on demo data with no handlers; with
  no handler passed there is no menu, so the demos are unchanged.

## Design

The menu's look exists: the header ⋯ menu (canvas `Feature - Header actions`,
23c). What the canvas does not have yet, for Claude Design:

> Orbital: a right-click context menu for a session, opened on a planet on
> the map, a Desk card, or a sidebar row. Reuse the 23c menu rows. Needs:
> (1) the menu at the pointer over a planet and over a sidebar row; (2) the
> three groups above with their icons — new glyphs only where 23b/23c have
> none (rename, regenerate name, change tag, copy path, end);
> (3) the Change tag view in place of the rows, with its back row; (4) how
> the planet and the row show they are the menu's subject while it is open
> (hover look held — confirm). A planet whose name is not truncated shows
> no cue today, since only its hover-expanded label is held; it needs a
> subject cue on the planet itself, and so does the Desk card, which has no
> hover look (it borrows the mat header's hover fill for now); (5) inert
> items for an offline machine; (6) whether Copy path wants a receipt (the
> app has no shared one); (7) where Regenerate name's progress shows when
> the session is not open — on its planet or its sidebar row.
> Constraints: no new motion on the map, nothing that pulses or glows
> (`docs/why-orbital.md`); the Planets and Desk themes both.

Until the canvas has it, build with the 23c rows and the hover look held;
the fidelity pass comes after the canvas.

## The phone

Left out on purpose. The phone has no map, and its session list already has
the ⋯ sheet with the same actions (`SessionMenuSheet`). A long-press on a
list row opening that same sheet would be the phone's counterpart; it is
written down as an idea, not built here. The phone's bundle changes — the
store's `setDialog`, the moved `menuFor` and the moved `primaryTag` are in
it — but its behaviour does not: no new route, no WS topic, and the sheet
reads the same items and the same tag as before.

## Known limitations

- **Rename…** on a session open in a detached window only brings that window
  forward; its title does not open for editing. Each window has its own
  store, and the request cannot cross to the other window's.

## Out of scope

- **Open pull request** (the maintainer's choice). The server looks up a
  branch's PR only while some client watches that session, so for a planet
  nobody has opened the PR is unknown or stale. Worth adding once the menu
  can ask for it.
- Moon menu, empty-map menu, tag-chip menu.
- Opening the session's folder in Finder or in the IDE: Orbital has no such
  action today, and a session on another device makes "reveal" mean
  something else. Copy path covers the need for now.
- Selecting several sessions and acting on all of them.
- Opening the menu from the keyboard.

## Tests

Worth a test: the item list per session (Orbital vs terminal, ended, offline
machine, take over offered or not) — pure logic with branches. Not worth one:
that the menu renders its rows.

## Shipping

Reaches the desktop only (`web/` outside `web/src/mobile`): a line in
`desktop/CHANGELOG.md`, a minor bump proposed. Moving `menuFor` touches
`web/src/mobile` imports without changing behaviour, so the phone is not
bumped.
