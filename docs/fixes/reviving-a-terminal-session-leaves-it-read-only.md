---
id: reviving-a-terminal-session-leaves-it-read-only
title: Reviving an ended terminal session leaves it source terminal, so the UI locks it read-only
status: done
type: fix
domain: sessions
tags:
  - runner
  - registry
---
# Reviving an ended terminal session leaves it `source: terminal`, so the UI locks it read-only

Reported live: session `056a9b26-65b3-4e0d-ba52-a7a1f11f3389` was opened
from history (an ended terminal session), the first message appeared to be
swallowed, and from then on the detail panel showed only
"runs in terminal — read-only".

## What actually happens

The revive itself works. `POST /api/sessions/:id/messages` catches the
runner's "inactive" throw and calls `runner.start({ resume: id })`
(`server/src/api/routes.ts:508`–`534`). The turn runs and the answer lands
in the transcript — for the reported session the assistant's reply and the
stop hook are on disk in the CLI transcript, and `last_at` matches. Nothing
was lost; it only *looked* swallowed because of what happened next.

Two things then mis-classify the session:

1. **The row's `source` never changes.** The revive reuses the same session
   row and the code path never writes `source: 'web'` — that value is only
   set on fresh inserts (`routes.ts:424`, `:626`, `:851`). The comment on
   `isReadOnly` in `web/src/lib/types.ts:241` promises "`continue` resumes
   it as a new `source: web` session", but no code does that. After the
   revive the API session is `{source: 'terminal', status: 'working'|'idle'}`,
   which is exactly the shape `isReadOnly` treats as *someone else's live
   terminal session* — so the composer is replaced by the read-only bar and
   the session can never be written to again from the UI, even though
   Orbital itself owns the process.

2. **Orbital's own SDK process registers as a "terminal".** The CLI the
   runner spawns writes `~/.claude/sessions/<pid>.json` like any other CLI
   (the reported session's entry carries `"entrypoint": "sdk-ts"`), so
   `SessionRegistry` lists it and `ctx.registry.get(id)` is truthy. That is
   harmless for `statusOf` (the runner wins), but the guards that mean
   "live in a foreign terminal" now also fire for sessions Orbital runs:
   the model route 409s (`routes.ts:590`), and after a server restart —
   runner gone, spawned CLI possibly still alive — the messages route would
   409 too.

## The fix

- The revive path now sets `source: 'web'` on the row right after
  `runner.start` succeeds, so the published upsert already carries the
  ownable shape and the composer stays open. Covered by
  `routes.test.ts` ("revive flips a terminal session to source \"web\"").
- `SessionRegistry.scan()` skips entries whose `entrypoint` starts with
  `sdk` — those are Agent-SDK-spawned CLIs (Orbital's own runner included),
  not terminals. Entries with no `entrypoint` field (older CLIs) are kept.
  Covered by `registry.test.ts` ("skips entries written by SDK-spawned
  CLIs").

A session already stuck in this state heals on its own: after a server
restart the runner no longer holds it and the registry no longer lists the
sdk-ts process, so it reads as `ended`, and the next continue flips it to
`source: 'web'`.
