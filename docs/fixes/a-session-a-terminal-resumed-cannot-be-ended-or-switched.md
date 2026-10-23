---
id: a-session-a-terminal-resumed-cannot-be-ended-or-switched
title: An Orbital session a terminal resumed cannot be ended or have its permission mode switched
type: fix
status: done
domain: sessions
related:
  - reviving-a-terminal-session-leaves-it-read-only
  - 2026-10-21-take-over-terminal-session-design
tags:
  - registry
---
# An Orbital session a terminal resumed cannot be ended or have its permission mode switched

Reported: a session resumed from the terminal cannot be ended, and its
permission mode cannot be switched.

## Reproduction

Reproduced against the running app:

1. Start a session from Orbital (`POST /api/sessions`). Its row is
   `source: web`.
2. In a terminal, `claude --resume <id>` from the same directory. The CLI
   writes `~/.claude/sessions/<pid>.json` with `entrypoint: "cli"`, next to
   the `sdk-ts` entry of Orbital's own process, so `SessionRegistry` lists it.
3. `POST /api/sessions/<id>/permission-mode` answers 409
   `session is live in a terminal`.
4. `POST /api/sessions/<id>/end` answers 200 and writes `endedAt`, but the
   session still reads `idle`.

The same happens to a terminal session that was revived in Orbital (which
turns it `source: web`) and then resumed in a terminal again.

## Why

- The client decides who owns a session from `source` alone: `isReadOnly`
  in `web/src/lib/types.ts` is `source === 'terminal' && status !== 'ended'`.
  For a `source: web` row it shows the mode switcher and End.
- The permission-mode route (and the model route) refuses any session
  `ctx.registry` lists.
- `endSession` stops the Runner's process and stamps the row, but
  `statusOf` in `server/src/api/shape.ts` asks the registry before it reads
  the stamp. As long as the terminal CLI lives, the registry's status wins and
  the stamp is never seen. Once the CLI exits, the session reads `ended`.

So the client offers what the server refuses, or accepts without effect.

## Fix

Fixed by Take over (spec `2026-10-21-take-over-terminal-session-design`):
the API shape reports a session the registry lists as `source: terminal`, so
the client locks what the server refuses; the registry's remove keeps a
`source: web` session on the map; and Take over ends the terminal CLI and
hands the session back to Orbital.
