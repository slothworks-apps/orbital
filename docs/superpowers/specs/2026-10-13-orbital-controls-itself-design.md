---
id: 2026-10-13-orbital-controls-itself-design
title: Orbital controls itself — every feature as an operation of the orbital MCP server
status: done
type: spec
domain: control
related:
  - 2026-10-12-a-session-archives-sessions-design
  - 2026-09-30-a-session-spawns-sessions-design
  - an-orbital-session-drives-orbital-through-a-catalog
  - orbital-features
tags:
  - server
  - runner
  - mcp
---
# Orbital controls itself

## Problem

A session Orbital runs can start sessions and archive them, and nothing else
of Orbital. Asked to retag a project's sessions, answer a waiting
permission, attach a harness or switch the map's theme, it can only tell the
user where to click.

## Rule

Every session Orbital runs gets three more tools on its `orbital` server
(ADR `an-orbital-session-drives-orbital-through-a-catalog`):

| tool | does | card |
|---|---|---|
| `orbital_operations` | lists the catalog, by `area` or `search` word: name, read or act, params, what it does | none |
| `orbital_read` | runs a read operation (`GET`) | none |
| `orbital_act` | runs an acting operation | the usual permission path |

The catalog is `server/src/control/catalog.ts`; the domain document
`orbital-features` maps every feature to its operation, and lists what has
no route.

## A call

`operation` and `params`. Path params are taken from `params` by name and
URL-encoded; `.` and `..` are refused. For `GET` and `DELETE` the rest is
the query string, otherwise the JSON body. The request enters the server
through `app.inject` with the API token, as a phone's does, but is checked
against the catalog instead of the phone's allowlist. The answer is the
route's JSON; a status of 400 or more comes back as an error with its body.

Refused before any route is reached:

- an unknown operation, or one called through the wrong tool;
- a missing path param;
- `end_session`, `clear_session`, `interrupt_session`, `send_message`,
  `rewind_session` and `restart_session_mcp` on the calling session — its
  turn is waiting on the call;
- `update_settings` with a `remote_*` key or `claude_executable_path`: the
  phone relay and its secret, and the executable Orbital runs, are the
  user's alone.

## Left out

The routes not in the catalog do not exist for a session: images and
uploads (bytes), the phone's pairing, devices and relay restart, the
browser's error reports, the terminals' shells, and the dev-only routes.

## The phone

Nothing to build. The tools run inside sessions on the Mac, including the
ones a phone starts; what they change reaches the phone through the usual
WebSocket topics.

## Tests

`server/test/controlTools.test.ts`: path params and query or body, an
encoded param that cannot climb out of its route, reads and acts kept to
their tools, the denied settings keys, the caller protected; an act and a
read through the real server; every operation pointing at a registered
route.
