---
id: 2026-10-12-new-session-missing-directory-design
title: New Session says a missing directory and offers to create it
type: spec
status: done
domain: sessions
related:
  - the-new-session-dialog-remembers-the-last-launch
  - spawn-failure-ends-a-session-silently
tags:
  - new-session
  - mobile
---

# New Session says a missing directory and offers to create it

## Problem

A directory typed into the desktop New Session dialog went straight to
`POST /api/sessions`. When it did not exist, the session row was written,
the SDK's spawn failed with `ENOENT`, and the user saw an error that did not
say the directory was the problem. The phone already sent
`requireDirectory: true` and showed *Directory not found* under its field,
but only after Start, and with no way forward except retyping.

## Behaviour

1. **While typing.** The form asks the server about the typed path, debounced
   (`DIRECTORY_CHECK_DEBOUNCE_MS`). A path that does not exist gets a line
   under the field saying so; a path that names a file, or is not absolute
   after `~` expands, gets a line saying that instead. A path that exists says
   nothing. The answer for a path the user has since edited is dropped.
2. **Start stays enabled for a missing directory.** Pressing it re-asks the
   server (the typed-while answer may be stale) and, when the directory is
   still missing, asks: *create it and start*, or *back to change it*.
   Back returns to the form with every field as it was. The `.mcp.json`
   question cannot apply to a directory that does not exist yet, so it is
   skipped after a create.
3. **A path that cannot be a directory** (a file, or relative) does not
   launch: Start is disabled while the line says why.
4. **The launch itself still refuses.** The desktop sends
   `requireDirectory: true` too, so a directory removed between the check and
   the launch gets `no_such_directory` back rather than a session that never
   runs.

Creating is recursive (`mkdir -p`): `~/Projects/new/thing` creates both.

## Server

- `GET /api/directory?path=` → `{ path, state }`, `path` with `~` expanded,
  `state` one of `directory`, `missing`, `not_a_directory`, `not_absolute`.
- `POST /api/directory` `{ path }` → 201 `{ path }`. 400 `not_absolute`,
  409 `not_a_directory` when a file is in the way, 403 `not_permitted` when
  the OS refuses.

Both expand `~` like `POST /api/sessions`, so the path checked, the path
created and the path launched are the same string.

## Phone

Built for the phone too. Both routes go on the allowlist: the phone can
already start a session that runs any command in any directory, so creating
one is no new power. The phone shows the same line under its field while
typing and the question as a sheet over the form, like the `.mcp.json`
question.

The phone updates before the Mac, so both are gated in `MAC_FEATURES` as
`directoryCheck`. Against an older Mac the phone keeps what it did: Start,
then *Directory not found* under the field from `no_such_directory`.
