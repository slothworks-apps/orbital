---
id: swept-sessions-need-a-tombstone
title: A deleted session needs a tombstone, because the indexer would put it back
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-21-settings-sections-design
  - settings-sections-split-by-kind
tags:
  - settings
  - indexer
  - retention
---
# A deleted session needs a tombstone, because the indexer would put it back

## The problem

Settings → General → "Delete sessions older than" was specified as a sweep
over the `sessions` table: delete the rows, leave `~/.claude` alone. That
reads as obviously correct — Orbital only ever reads the CLI's transcripts —
and it does not work.

`indexProjects` walks every `.jsonl` under `<claudeDir>/projects` and
inserts any session the database does not have. It runs at boot and again,
debounced, on every change the watcher sees. So a swept row whose transcript
is still on disk comes back within one scan. There is no ordering that fixes
this: sweep before the scan and the scan re-adds it; sweep after and the next
file event does.

As specified, the row would have deleted only sessions whose transcripts the
CLI had already removed. That is a garbage collector for orphan rows, not
the retention policy the row promises.

## The decision

A sweep writes a tombstone. `swept_sessions(id, swept_at)` — one row per
deleted session — and `indexProjects` loads the set once per scan and skips
any transcript it names.

**The tombstone is dated, and that is the load-bearing part.** A flag would
be a permanent blocklist: resume an old session in the CLI and it would stay
invisible in Orbital forever, with nothing in the UI to explain why. Instead
the indexer compares the transcript's mtime against `swept_at`:

- mtime **≤** `swept_at` — untouched since the sweep. Stays hidden.
- mtime **>** `swept_at` — written to since, which means the session was
  resumed. The tombstone is dropped and the file indexed like any other.

So the rule is "hidden until you use it again", and it repairs itself
without anybody having to know the table exists.

## What was rejected

**Deleting the transcript too.** It would have been complete and cheap, and
it would have made Orbital a writer to a tree the CLI owns. Losing a
transcript is not recoverable, and "Orbital only reads `~/.claude`" is worth
more than this row. Not done, and not to be done without the owner asking
for it in as many words.

**Making it a filter** — "Hide sessions older than", excluded in
`GET /api/sessions`. Honest, reversible, no migration, and it does nothing
about a database that keeps growing, which is the complaint the row exists
to answer.

## Consequences

- Migration `0010_swept_sessions`. The table is small: one row per deleted
  session, and rows leave it as soon as their transcript moves.
- `indexProjects` gains one `SELECT` per scan — not per file — and a map
  lookup per transcript. A scan already `stat`s every file, so this is
  noise next to what it does anyway.
- The sweep must run BEFORE `indexProjects` at boot. Both orders give the
  same end state, but the other way round parses every transcript on the
  machine to build rows it is about to delete.
- `sweepSessions` takes `now` explicitly rather than calling the clock, so
  the stamp the indexer later compares against is the caller's decision and
  the tests can pin it.
- Retention also runs on the `PATCH` that sets it, not only at boot. The
  dialog confirms "this deletes N sessions" before saving, and a
  confirmation that meant "at some future restart" would be a lie.
