---
id: 2026-10-19-docked-sessions-design
title: Docked sessions — live work put away, and a sidebar you sort by hand
status: done
type: spec
domain: sessions
related:
  - 2026-09-20-pinned-sessions-design
  - 2026-09-24-sessions-end-only-by-hand-design
  - a-session-ends-only-when-the-user-ends-it
  - 2026-10-05-mobile-next-design
  - why-orbital
tags:
  - server
  - web
  - sidebar
  - map
  - mobile
---
# Docked sessions

## Why

Some work comes back about once a week. It is not finished, so it does not
belong in HISTORY, but between those weeks it should not sit among the
sessions you work on every day, on the map or in your head. Today there are
two choices: leave it live and have it clutter ACTIVE and the map, or end it
and dig it out of HISTORY later.

A **docked** session is live but put away. It is a session like any other,
with nothing ended or stopped. It is just out of sight until you go back
to it.

With it, the sidebar becomes something you sort by hand: every section
collapses, and rows move between sections by drag and drop or from a
right-click menu.

## Goals

- A docked state: off the map, in its own sidebar section, still a normal
  session you can open and write to.
- Every sidebar section (PINNED, ACTIVE, DOCKED, HISTORY) collapses, and its
  heading says enough to make opening it unnecessary.
- Drag a row between sections. Only the moves that mean something are
  allowed (table below).
- A right-click menu on sidebar rows and on planets, with the same actions
  as the phone's session menu, plus Dock / Undock.
- The phone can dock and undock, and shows a DOCKED fold.

## Non-goals

- Reordering rows inside a section. PINNED keeps pin order, as today.
- Dragging a planet from the map into the sidebar.
- Drag and drop on the phone. The menu covers it there.
- Docking on a timer, or suggesting what to dock.

## Anti-goals

- Docked becoming a second archive. It holds live work, and ending a
  session is still End or HISTORY.
- A docked session that comes back on its own when the agent answers. The
  user put it away, and it stays away until they write to it (§ Rules).
- Headings turning into counters that ask for attention: no badges, no
  accent colour for waiting (`why-orbital.md` → Waiting is fine, Silence by
  default).

## Rules

### State

- `sessions.docked_at`: nullable integer ms, `null` = not docked. Same
  shape as `pinned_at`.
- A docked session is never pinned or ended (a pin and an end can still
  coexist, as before); the latest action wins:
  - Docking clears `pinned_at`.
  - Pinning clears `docked_at`. Docked → Pinned means "bring it back and pin
    it".
  - Ending clears `docked_at`, in `endSession`.
  - Docking an ended session reopens it (clears `ended_at`). That is
    HISTORY → DOCKED.
- A docked session keeps its real status (working, needs_input, idle) and
  shows it on its row, as a pinned live row does.

### What brings a docked session back

- **Only the user writing to it.** The user's message route
  (`POST /api/sessions/:id/messages`) clears `docked_at` once the message is
  taken, delivered or queued for a limit reset, so it works the same from the
  desktop composer, the phone, a detached window, or a session opened from
  DOCKED. Not `deliverToSession` itself: a limit's continuation and a
  harness step go through it on their own. A delivery that fails leaves the
  session docked.
- Agent activity never undocks. A session docked mid-turn finishes in
  DOCKED and stays there. One that stops on a question or a permission
  request also stays docked and waits quietly. Its row shows it, and so does
  the DOCKED heading.
- A terminal session cannot be docked (the route answers 409, as reopen
  does): it ends when its CLI exits, which no stamp stops, and a docked
  session is never ended. Undocking stays open to every row. *(Changed after
  review; the first cut let a live terminal session dock.)*

### Notifications

- A docked session notifies nothing, whatever the notification settings
  say: not needing input, not Done, not ending mid-turn. Docked means out of
  your head. That it waits shows in the DOCKED heading when you look. The
  rule lives in `shared/src/notifications.ts`, reading `dockedAt` from the
  upsert, so the desktop and the phone both follow it. *(The user's decision.)*

### Map

- `holdsMapPlace` is false for a docked session, so docking plays the same
  leave-fade as ending, and undocking brings the planet back.
- The trash label and its click stay about ended sessions only. Docked rows
  are not counted there.
- Every map theme (Planets, Desk, Archipelago) opens the right-click menu
  on its session body.

### Sidebar sections

Order: **PINNED · ACTIVE · DOCKED · HISTORY**.

- DOCKED, like PINNED, is absent while it is empty. While a row is
  dragged, an empty one shows as a band floating over the list (no height
  of its own), so nothing moves under the pointer.
- Every heading is a toggle that collapses its section. Collapse state is
  kept per section in one setting (`sidebar_sections_collapsed`, a JSON
  set of section keys) and survives reload.
- Defaults: DOCKED starts collapsed; the others start open, so nothing
  changes for someone updating until they click. *(The author's call.)*
- Heading content: label, row count, and when any row in the section is
  waiting on the user, a muted ` · N waiting` in the heading's text colour,
  not the accent. HISTORY keeps no count: its rows are paged, and a count
  would need another request to be honest. ACTIVE keeps its origin filter. *(The heading content is the author's call; the
  user asked for "some information" in the heading.)*
- A collapsed HISTORY stops paging. Clicking the map's trash opens HISTORY
  if it is collapsed, then scrolls to it.
- The ⌃⇥ cycling and "next waiting" shortcuts walk PINNED + ACTIVE, as
  today. DOCKED is left out, like HISTORY. A collapsed section's rows are
  still in that order. Collapsing hides rows, it does not remove them.

### Moves

| from → to | result |
|---|---|
| Active → Docked | docked; leaves the map |
| Active → Pinned | pinned |
| Pinned → Active | unpinned |
| Pinned → Docked | unpinned and docked |
| Docked → Active | undocked; back on the map |
| Docked → Pinned | undocked and pinned |
| any → History | ended, through the trash's rules (`trashDropFor`): at once with Undo, a confirm while working or waiting, refused for a live terminal session |
| History → Active | reopened |
| History → Pinned | pinned, still ended, as the pin button does today *(author's call)* |
| History → Docked | reopened and docked |

PINNED can hold ended rows (a pin keeps an ended session in the sidebar).
Moving one of those out follows its destination: → Active reopens and
unpins, → Docked reopens, unpins and docks, → History unpins.

- Dropping a row on its own section does nothing. A drop the table does not
  allow shows no drop highlight.
- "Active" for a dropped ended row means status ended → not ended, so
  `POST /api/sessions/:id/reopen`.
- The drag uses native HTML5 drag events, as the tag-rule list does
  (`TagsRules.tsx`). No new dependency. A drop target is the section's
  heading plus its list, including a collapsed heading.

### Right-click menu

On a sidebar row and on a planet, built on `web/src/ui/Menu.tsx`:

- Pin to top / Unpin
- Dock / Undock
- Rename
- Change tag
- —
- Clear and start over
- End session (Reopen on an ended row)

A session from another Mac in the group that does not dock yet (its rows
carry no `dockedAt`) is offered no Dock. Only what fits the row is shown: an ended row shows Reopen, Pin (as today)
and Rename / Change tag, and no Dock until it is reopened. A live terminal
session shows Pin, Dock, Rename and Change tag. Clear and End go through the
same dialogs and rules as the detail panel. Keyboard: the context-menu key
or ⇧F10 on a focused row opens it.

## Server

- Migration: `docked_at` column.
- `PUT /api/sessions/:id/docked {docked: boolean}`, mirroring
  `PUT /:id/pinned`: 400 on a non-boolean, 404 on an unknown id, broadcasts
  the upsert. `docked: true` clears `pinned_at` and `ended_at`.
  `pinned: true` clears `docked_at`.
- `dockedAt: number | null` joins the API session shape.
- `GET /api/sessions` orders pinned rows first, then docked rows (in dock
  order), then the rest by recency. A docked session goes stale by
  `last_at`, and DOCKED must not depend on HISTORY paging it in.
- Retention ("Delete sessions older than") spares a docked session, as it
  spares a pinned one: work that comes back weekly is exactly what an age
  cutoff would otherwise catch.
- `dock_session` joins the operations catalog next to `pin_session`.
- `list_sessions` on the orbital MCP server reports `docked: boolean` next
  to `pinned`. `archive_session` treats a docked session like any live one.

## Phone

Built for the phone too.

- `SessionMenuSheet` gains Dock / Undock.
- The list gains a DOCKED fold above ENDED, collapsed by default, with the
  same heading content as the desktop. Docked rows leave the
  input / working / idle bands.
- `PUT /api/sessions/:id/docked` goes on the allowlist
  (`server/src/remote/allowlist.ts`).
- The phone updates first, so Dock / Undock and the fold are gated in
  `MAC_FEATURES` on the Mac version that ships `docked_at`. Against an older
  Mac the menu has no Dock item, and `dockedAt` is absent, so nothing is
  grouped as docked.
- Writing to a docked session from the phone undocks it through the server.
  No phone code is needed for that.

## Scope

- **For:** anyone running several sessions where some come back weekly.
  That is the multitasking case Orbital exists for.
- **Where:** on by default. Nothing changes after updating until the user
  uses it: DOCKED is absent while empty, the other sections start open, and
  the menu and drag are new gestures, not changed ones.
- **What a current user notices:** the section headings can be clicked to
  collapse, and they show counts, with a muted `· N waiting` on PINNED and
  ACTIVE while a session waits for them. Every sidebar row can be dragged.
  Right-click now opens a menu.
- **Settings:** none new. Collapse state is remembered, not configured.

## Tests

Worth writing:

- The `docked` route: stamp clearing against pinned and ended, 400/404.
- `deliverToSession` clearing `docked_at`.
- `partitionSessions` with docked rows.
- The pure move table (`dropFor(from, to, session)`): the result per pair,
  disallowed pairs, the History rules delegating to `trashDropFor`.
- `holdsMapPlace` for docked.
- The phone grouping with `dockedAt`, and with it absent (older Mac).

Not worth writing: menu rendering, heading styling, drag highlight visuals.

## Left to the builder

- Visual values for the headings, the collapse chevron, the drop highlight
  and the docked row: follow the existing sidebar language. The maintainer
  checks them against the design.
- The menu's exact placement and icons.
- Whether the collapse and drag code lives in `Sidebar.tsx` or a small
  sibling module.
