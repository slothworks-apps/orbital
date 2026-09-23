---
id: git-location-is-ambient-not-recorded
title: The git location is the directory's live state, not a session record
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-22-git-location-indicator-design
  - tilde-expands-at-the-api-boundary
  - context-usage-has-one-source
tags:
  - git
  - sessions
---
# The git location is the directory's live state, not a session record

## The problem

The detail panel is getting an indicator that says where a session works:
the branch, and whether the directory is the repository's main checkout or a
worktree attached to it. A session already carries the one input this needs —
its `cwd` — but nothing in orbital has ever read git.

That leaves a choice about what the indicator is actually a statement about.
A branch is not a stable property of a session: an agent can run
`git checkout` mid-turn, and a human can switch the branch under a session
that is sitting idle. So there are two different true things the panel could
say, and they diverge the moment anything moves:

- **what the directory is on now** — read at display time, always current,
  and for a session that ended last Tuesday it describes the directory's
  today rather than the session's Tuesday;
- **what the session was on** — stamped into the session row when the session
  starts (and whenever a turn runs), permanently true about that session, and
  wrong about the directory as soon as the branch changes.

## What was decided

**The indicator reads the directory, live.** `GitStore` resolves a `cwd` to
a repository root and reads `HEAD` from disk; the value is cached per root
and invalidated by a watcher on that same `HEAD`, so a `git checkout`
reaches the panel within a beat. Nothing is written to the database, no
column is added to the session row, and no migration is needed.

This follows the reason the indicator exists at all: it is there to orient
someone running several agents at once — *what is running where, right now*.
That question is about the present state of the working trees, and a
stamped-at-start value would answer a question nobody asked while quietly
going stale.

It also matches how the session shape already works. `toApiSession` is not
a projection of a database row: `status`, `subagents` and `pendingDecision`
are all pulled from live sources at shape time (`server/src/api/shape.ts`).
`git` joins them as a fourth.

## What follows from it

**An ended session shows where its directory stands today.** Open a session
that finished on `feature/tray` after the branch was merged and deleted, and
the panel reads `main` — because that is what the folder is on. The indicator
is worded and placed as a property of the location, not as a fact about the
session's history, so this reads as orientation rather than as a lie. If a
historical record is ever wanted, it is a different feature with a different
surface, and it needs the column this decision declines to add.

**Two sessions in the same directory always agree.** The value is keyed by
repository root, not by session, so there is no way for two panels open on
the same checkout to show different branches. That is the property that makes
the indicator usable for spotting that two agents share a working tree, even
though the indicator itself draws no attention to it.

**Staleness is bounded by the watcher, not by a refresh interval.** There is
no polling and no "refresh" affordance. If the watcher ever fails to fire,
the failure mode is a stale branch name with nothing on screen admitting it —
which is the cost of choosing live state, and the reason the read is a plain
file read with no process to fail.
