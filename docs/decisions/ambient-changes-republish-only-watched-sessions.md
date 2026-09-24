---
id: ambient-changes-republish-only-watched-sessions
title: A branch or editor change republishes only live and open sessions
type: adr
status: in-force
domain: sessions
related:
  - resource-usage-pass-2026-09-24
  - git-location-is-ambient-not-recorded
  - orbital-speaks-to-the-ide-itself
tags:
  - server
  - performance
  - git
  - ide
---

# A branch or editor change republishes only live and open sessions

## The problem

A session's `git` and `ide` fields describe its directory, not the session
([[git-location-is-ambient-not-recorded]]). When a `HEAD` moves or the editor
selection changes, `GitStore` and `IdeStore` name the affected `cwd`s, and the
server republishes the sessions in them.

It republished every session row in those directories. A workspace holds
every session ever run there: 140 for one, 72 for orbital. So one selection
drag in WebStorm meant hundreds of full upserts per flush, each a few queries
on the server and a store update in the browser (audit
[[resource-usage-pass-2026-09-24]], finding 4).

## The decision

`republishCwds` (`server/src/index.ts`) republishes a session only when
`wantsAmbientUpdates` says someone uses the value now:

- it is live: the Runner owns it and it has not ended, or the CLI registry
  lists it;
- or a window has it open: `session:<id>` has a subscriber.

The second rule exists because ended sessions do show these fields. The
header shows the branch, and the composer of an ended session ("Continue
conversation…") shows the editor selection and sends it with the next prompt.
Every web surface that reads `git` or `ide` is scoped to a session that is
open, and each of them subscribes to `session:<id>`.

The first subscriber to `session:<id>` republishes that session. So an ended
session that was skipped while nobody had it open is fresh the moment it is
opened.

## What was ruled out

- **Live sessions only.** The composer of an ended session would send a stale
  selection with the prompt that continues it.
- **A small `ide` frame the client applies by `cwd`.** It would fix the cost
  too, and it would keep every copy in the browser fresh. But it needs a new
  topic event and client code, and it covers the selection only, not `HEAD`
  or an editor opening. Nothing reads the value for a session that is not
  open, so keeping those copies fresh buys nothing.

## What follows

The browser's copy of `git` and `ide` for an ended session nobody has open
can be stale. Nothing displays it, and opening the session replaces it. Code
that starts reading these fields for sessions that are not open, such as a
map mark or a search by branch, has to revisit this.
