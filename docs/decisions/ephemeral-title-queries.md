---
id: ephemeral-title-queries
title: Title queries run ephemeral, so they never appear on the map
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-18-auto-title-design
tags:
  - titler
  - watcher
---

# Title queries run ephemeral, so they never appear on the map

The titler asks a model to name a session by spawning `claude` through the
Agent SDK, exactly as a real session does. The CLI therefore did what it does
for any session: wrote a transcript to
`~/.claude/projects/<slug of the server's cwd>/<uuid>.jsonl`.

That directory is inside the tree the watcher indexes, and nothing in the file
says "this was a classifier call". Orbital picked each title query up as an
ordinary session — a planet on the map, named after the prompt it was given
("Current name: …"), sitting in the server's own working directory. Two of
them had accumulated before anyone noticed.

## Decision

Pass `persistSession: false` on the title query. The SDK's own words: the
session is not written to `~/.claude/projects/` and cannot be resumed later,
which is what an ephemeral, automated call wants. Nothing reaches the watcher,
so nothing has to be filtered back out.

## Ruled out

- **Recognising title transcripts in the indexer.** The only handle is the
  prompt's opening words, which is the prompt text doubling as a wire format:
  it breaks the first time the prompt is reworded, and it would silently hide
  a real session that happened to start the same way.
- **Deleting the transcript afterwards with the SDK's `deleteSession`.** The
  watcher is live, so the file exists — and is indexed — for as long as the
  query runs. It would turn a permanent ghost into a flickering one and leave
  a tombstone row behind.
- **Pointing the call at another `CLAUDE_CONFIG_DIR`.** It moves the
  transcript out of the watched tree but takes the CLI's settings and
  onboarding state with it, to fix an indexing problem with an auth-shaped
  risk.

## Consequence

A title query can no longer be resumed or read back from disk — acceptable,
because nothing ever did. Sessions already indexed from earlier title calls
stay in the database until they are removed by hand or swept by retention;
this decision stops new ones, it does not clean up old ones.

`ModelCatalog.probe()` makes a similar one-shot call but never sends a turn
and leaves no transcript, so it is untouched.
