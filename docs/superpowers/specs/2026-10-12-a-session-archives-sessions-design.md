---
id: 2026-10-12-a-session-archives-sessions-design
title: A session lists and archives sessions — cleanup from an orchestrating session
status: done
type: spec
domain: sessions
related:
  - 2026-09-30-a-session-spawns-sessions-design
  - a-session-ends-only-when-the-user-ends-it
  - 2026-09-23-end-session-design
tags:
  - server
  - runner
---
# A session lists and archives sessions

## Problem

A session that directs other sessions — spawning them with
`spawn_session`, handing them tasks — leaves a trail of finished and idle
planets behind. It cannot see them and cannot put them away, so the user
drags each one to the trash by hand.

## Rule

Every session Orbital runs gets two more tools on its `orbital` MCP server,
beside `spawn_session`. Terminal sessions do not, for the reason
`spawn_session` gives.

"Archived" is Orbital's `ended`: the stamp the user's End and the trash
write (ADR `a-session-ends-only-when-the-user-ends-it`). There is no second
kind of archive. The ADR keeps `ended_at` for the user's explicit actions;
an archive call is one, made through a tool the user grants like any other.

## `list_sessions`

| input | meaning |
|---|---|
| `cwd` | only sessions whose cwd is this directory or below it; absolute, `~` expanded |
| `include_archived` | include ended sessions; default false |
| `limit` | at most this many, most recent first; default 50, max 200 |

Each session: `id`, `title`, `cwd`, `source`, `status` (`working`,
`needs_input`, `idle`, `ended`), `alive` (a process holds it now), `pinned`,
`lastAt`, `archivedAt`, `self` (it is the caller). Sessions of removed
Claude directories and harness drafting conversations are left out, as in
`GET /api/sessions`.

It only reads, so it is in `allowedTools`: no permission card.

## `archive_session`

Input: `ids`, and `force`. For each id, once, in order, one result:

- `not_found`;
- `refused` — the caller itself (ending it would stop the turn waiting on
  the call; `force` does not change this), and a terminal session still
  running (only its CLI exiting ends it);
- `already_archived` — ended and not pinned; nothing is written;
- `refused` without `force` — pinned, `working` or `needs_input`: what the
  trash would ask about first;
- `archived` — through the same `endSession` as End, with the trash's
  unpin. The harness pauses, a limit wait is dropped, the user's terminals
  close, the process stops, the map loses the planet; Undo in the session
  still brings it back.

It goes through the usual permission path: a card in `default` and
`acceptEdits`, none under `bypassPermissions`.

The description says it is for sessions that are finished or no longer
used, when the user asked the session to look after them, and that
`force` is for when the user asked for exactly that.

## The phone

Nothing to build. The tools run inside a session on the Mac; what they
change reaches the phone through the `sessions` topic like any End.

## Tests

`server/test/routes.test.ts`: the list without and with archived sessions
and the caller marked; the `cwd` filter by directory, not by prefix; an
idle session archived, a repeat reported as already archived; a working
and a pinned session refused without `force` and archived with it; the
caller refused always.
