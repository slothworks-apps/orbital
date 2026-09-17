---
id: 2026-09-17-session-origin-design
title: Session origin — read-only rows and an origin menu
status: done
type: spec
domain: sessions
related:
  - 2026-09-15-orbital-design
  - origin-filter-scopes-to-map-and-active
  - subagents-only-for-orbital-sessions
tags:
  - sessions
  - sidebar
---
# Session origin — read-only rows and an origin menu

**Date:** 2026-09-17
**Visual design:** `Feature - Session origin.dc.html` on the live Claude
Design canvas (project `df77470e-1384-436c-8b25-5e01acfc497f`), artboards `3a`
(full screen) and `3b` (the parts). Read it through the `DesignSync` MCP; any
export under `design/` is stale.

## Why

Orbital lists two kinds of session under one heading: the ones it started
itself (`source: web`) and the ones it merely indexed from another terminal
(`source: terminal`). The second kind cannot be driven from Orbital — the
composer refuses input and the server answers `409` on
`POST /sessions/:id/messages` — but nothing in the list said so. The user
found out by typing into one.

The filter for the distinction already exists: a second row of chips
(`all` / `terminal` / `web`) under the tag chips. It works, and it reads as an
afterthought — a filter row that duplicates the one above it, in vocabulary
(`web`) that names an implementation rather than what the user did.

This change says the same two things better: mark the rows, and move the
filter into the heading of the list it belongs to.

## What is built

### 1. The `read-only` badge

A neutral pill after the session name on an ACTIVE row whose session is
`source: 'terminal'` and not `ended`.

- 9px JetBrains Mono, `letter-spacing: .1em`, border `rgba(150,205,255,.18)`,
  fill `rgba(150,205,255,.04)`, ink `rgba(160,190,225,.75)`, 4px radius.
- No hue and no icon. Hue belongs to tags; a second hue system on the same
  row would make the tag dot ambiguous.
- The name truncates before the badge does, and the badge never wraps.
- Orbital-started sessions carry no badge. Unmarked is the norm.
- `title="Attached from an external terminal · read-only in Orbital"`.

HISTORY rows never draw it: an ended terminal session is not read-only —
`POST /sessions/:id/continue` resumes it as a new `source: web` session.

The predicate is the one `DetailPanel` already applies as `isTerminalLive`.
It moves to `lib/types.ts` as `isReadOnly(session)` so the badge and the
composer cannot drift apart.

### 2. The origin menu

The chip row is removed. Its place is the right end of the `ACTIVE` heading,
as a text trigger with a caret.

- Options carry live counts: `all sessions 5` / `started in orbital 3` /
  `other terminals · read-only 2`. Counts are over the ACTIVE list after the
  tag and search filters, so `all sessions` always equals the number beside
  the `ACTIVE` heading.
- The trigger shows the short form: `all` / `in orbital` / `read-only`.
- Resting state is bare — transparent border, inherited ink. It lights up
  (border `rgba(150,205,255,.22)`, fill `rgba(150,205,255,.12)`, accent ink)
  while the popup is open or the filter is not `all`, so a narrowed list is
  never silent about being narrowed.
- The popup is the one `ui/Select` already draws (canvas 1b): 5px padding,
  10px radius, flat `rgba(10,16,28,.96)`, rows at a 7px radius, ✓ on the
  selection.

`ui/Select` grows four things for this, and nothing else:

- a `ghost` trigger variant, plus an `active` flag that keeps it lit while
  the value it carries is narrowing something;
- an optional `count` on an option, muted and right-aligned before the ✓
  column — which is reserved on every row once any option has one, so the
  counts line up;
- an optional `short` label, shown on the trigger in place of `label`;
- right-alignment for the `ghost` popup. A trigger at the right end of a
  300px panel with a menu aligned to its LEFT edge puts the menu on the map.

Everything else the acceptance asks for — Enter/Space opens, arrows move,
Escape closes without committing, outside click dismisses, the popup flips
near the viewport edge — it already does. Extending it rather than building a
local menu is `web/CLAUDE.md`'s standing rule.

### 3. Filter scope

The filter applies to the map and to the ACTIVE list. HISTORY is untouched.
See `origin-filter-scopes-to-map-and-active` for why, and for what that costs.

In `store.ts` this means `visibleSessions` stops applying `ui.sourceFilter`
and `mapSessions` starts applying it. `Sidebar` applies it when it splits
`visible` into `active` and `history`, to `active` only.

`Sidebar.loadMore` stops sending `?source=`. Paging is over the whole list,
HISTORY included, so a server-side origin filter would drop history rows
before the client could show them. `sourceFilter` also leaves the effect that
resets `exhausted`: the filter no longer changes which rows the server
returns, so the paging cursor stays valid across a switch.
`GET /api/sessions?source=` keeps working; the web client just has no use
for it.

## What changes for the user

- A terminal session in ACTIVE is marked before they click it.
- The origin filter narrows the ACTIVE list and the map together.
- The footer count (`N sessions`) no longer follows the origin filter — it
  counts everything the tag and search filters leave.
- The collapsed rail shows neither trigger nor badge. Both live inside the
  expanded layer, which `inert` already removes.

## Acceptance

- Every non-ended terminal row in ACTIVE shows the badge, including rows that
  arrive over the websocket while the app is open.
- No HISTORY row ever shows the badge.
- Selecting an option closes the menu, updates the `ACTIVE` count and the
  map, and leaves the HISTORY list unchanged.
- The menu opens on Enter/Space, moves on arrows, closes on Escape without
  committing, and closes on an outside click.
- Option counts match what the list shows after the switch.
