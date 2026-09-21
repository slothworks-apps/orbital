---
id: dogfood-and-dev-side-by-side
title: Running the Orbital you work in beside the one you are changing
type: runbook
status: in-force
domain: sessions
related:
  - 2026-09-21-session-autoheal-design
---

# Running the Orbital you work in beside the one you are changing

## The problem this solves

`npm run dev -w server` is `tsx watch`. Every save to `server/src` restarts
the process, and the restart kills every `claude` subprocess that server is
running — which is every session Orbital started.

While an agent is implementing something in `server/src`, that is a save
every few seconds. One measured stretch: **twelve restarts between 16:55 and
16:58**, each one killing and re-resuming the same session. No turn longer
than the gap between two saves can finish, so a session you are trying to
work in simply never progresses.

Autoheal (spec `2026-09-21-session-autoheal-design`) brings the session back
after each restart. It cannot protect a turn that was in flight, and it is
not meant to: it makes a restart survivable, not free. **A server you are
editing is not a server you can work in.** The fix is two instances.

## The two instances

| | dogfood | dev |
|---|---|---|
| command | `npm run dogfood` | `npm run dev` |
| port | 4737 | 4838 |
| database | `~/Library/Application Support/orbital` | `…/orbital-dev` |
| frontend | built, served same-origin | vite on 5173, proxying 4838 |
| restarts when you save | no | yes, that is the point |

Both read the same `~/.claude`, so the dev instance still sees real
transcripts to index. Only the database differs, which is what keeps a save
from touching the sessions you are living in.

`npm run dogfood` builds the server and the web app, then runs the bundle.
There is no watcher, so it stays up until you stop it.

```bash
npm run dev:seed         # once, before the first `npm run dev`
npm run dogfood          # the one you work in       → http://127.0.0.1:4737
npm run dev              # the one you are changing  → http://localhost:5173
```

## Seed the dev database first

A fresh dev database starts at `DEFAULT_SETTINGS`, which throws away real
work: the permission mode and model you chose, `default_project_dir`, panel
widths, context thresholds, notification flags, and every tag and tag rule.

Worst of the lot is `model_context_windows`. It is **learned** from turns as
they run, not configured — so a database without it leaves the map's context
arc with no denominator until every model has been seen again.

`npm run dev:seed` copies the dogfood database over and scrubs `runner_status`
from every row. The scrub is the point: that column is the Runner's claim on
a session, and a second database carrying it would have the dev server
autoheal at boot and spawn its own `claude --resume` for a session the
dogfood server is already running.

It refuses to overwrite an existing dev database; `npm run dev:seed -- --force`
re-seeds from scratch, which is also how you throw dev state away.

## When you change the server, the dogfood instance is stale

It is running a bundle built at launch. To pick up your work, stop it and run
`npm run dogfood` again — which restarts it, which kills its sessions, which
autoheal then brings back. Do it deliberately, between turns, rather than
having it happen to you mid-turn on every save.

## Gotchas

- **The desktop probes whatever `ORBITAL_PORT` says**, which is why
  `npm run dev:desktop` exports 4838 like the other dev scripts. It has to
  agree with vite: the window loads vite on 5173, whose `/api` proxy points
  at 4838, while the desktop's own notification socket opens
  `ws://127.0.0.1:<ORBITAL_PORT>/ws` directly. Leave them disagreeing and the
  map shows one server's sessions while notifications arrive from another's.
  The packaged app has no such variable and keeps probing 4737, where the
  dogfood instance is.
- **Do not remove the desktop's attach branch.** Now that a server is
  normally already running on 4737, attaching is what stops the desktop
  forking a *second* one onto the same database — the two-servers-one-database
  hazard below, arrived at from the other direction.
- **A session started in the dev instance** writes its transcript to the real
  `~/.claude`, so the dogfood instance will index it as a terminal session.
  Harmless, but it is why a session can appear in both.
- **Never run two servers on one database.** Both would autoheal the same
  rows at boot and each spawn its own `claude --resume` for the same session
  id. The separate `ORBITAL_DATA_DIR` above is what prevents it.
- **A seeded dev database still holds the dogfood instance's `web` sessions.**
  Autoheal cannot touch them — the seed scrubbed the claims — but *sending a
  message* to one in the dev instance revives it there, while the dogfood
  instance may be running it too. Two CLIs, one transcript. Read them in dev;
  do not write to them.
- **`npm run dev` no longer answers on 4737.** Anything pointed there by hand
  (curl, a bookmarked tab) now reaches the dogfood instance.
