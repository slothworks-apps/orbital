---
id: tilde-expands-at-the-api-boundary
title: A typed ~ expands where the request enters the server, not in the browser
status: in-force
type: adr
domain: sessions
related:
  - runner-pins-the-session-id
  - spawn-failure-ends-a-session-silently
  - tag-rule-patterns-are-regexes
tags:
  - runner
  - paths
---
# A typed ~ expands where the request enters the server, not in the browser

## The problem

Launching a web session against `~/Projects/slothworks/atlas` did nothing. A
planet appeared in ACTIVE and went straight to ended, no prompt was ever
answered, and no transcript was ever written under `~/.claude/projects`.

The tilde was literal the whole way down. `NewSessionDialog` prefills its
PROJECT DIRECTORY field from the `default_project_dir` setting, which is a
free-text field and held `~/Projects/slothworks`; the user appended
`/atlas`. `POST /api/sessions` passed `body.cwd` verbatim to
`Runner.start()`, which passed it to the Agent SDK as `options.cwd`, which
handed it to `child_process.spawn`. Nothing along that path is a shell, so
`~` stayed a directory name that does not exist and the spawn failed with
`ENOENT`.

Of every session ever recorded, exactly one had a cwd beginning with `~`, and
it is the one that never ran.

## The decision

`expandHome()` in `server/src/paths.ts` is the single place a typed path
becomes a real one, and `POST /api/sessions` calls it on `body.cwd` before
either the runner or the `sessions` insert sees the value.

That route is the only door an unexpanded path comes through. Every other
`cwd` in `routes.ts` — the revive in `POST /api/sessions/:id/messages`, the
`startNew` in `clear`, the grouping in `/api/projects` — reads a row that
this insert already wrote, so expanding once at the door covers all of them.

Expanding *before* the insert and not only before the spawn is deliberate:
`/api/projects` groups by the stored string, so a row holding `~/x` and a row
holding `/Users/tomin/x` would list one directory twice and split the
per-project model memory between the two spellings.

Only `~` alone and a leading `~/` expand. `~alice` is another user's home,
which the password database answers and Orbital does not consult, and a tilde
anywhere else is an ordinary character in a directory name.

## What was rejected

**Expanding in the browser.** `NewSessionDialog` would have to know the
server's home directory, which means shipping it over the API for no other
reason, and it would leave the REST endpoint still accepting a path it cannot
run — anything not going through the dialog would fail exactly as before.

**Expanding inside `Runner.start()`.** It fixes the spawn and nothing else:
the row still stores `~/x`, so `/api/projects` still double-counts. The
runner also takes a `cwd` from callers who read it back out of the database,
where it is already absolute, so the expansion would sit on the wrong side of
the value's lifetime.

**Rejecting a `~` path with a 400.** Honest, but it makes the user do by hand
what one line does correctly, and the tilde is the spelling the settings field
invites.

## Consequences

`tags/rules.ts` had grown its own copy of the expansion, for the same reason —
tag rule patterns are typed by hand too — and for a while called the shared
helper. The shared behaviour narrowed slightly and for the better: `~alice/**`
used to become `/Users/tominalice/**`, a path nobody has. Since
[[tag-rule-patterns-are-regexes]] the rules matcher expands the tilde itself
again — the expanded home directory has to be regex-escaped, which is a
concern `expandHome` (whose output is a real path) rightly does not have.

Sessions already stored with a literal `~` are not rewritten. There is one,
it never ran, and migrating a single dead row is not worth a migration.
