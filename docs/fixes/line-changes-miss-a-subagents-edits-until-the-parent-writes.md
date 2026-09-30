---
id: line-changes-miss-a-subagents-edits-until-the-parent-writes
title: The header's line changes miss a subagent's edits until the parent transcript is written
status: backlog
type: fix
domain: sessions
related:
  - 2026-09-30-branch-pr-and-line-changes-design
  - branch-status-comes-from-git-and-gh-processes
tags:
  - git
  - subagents
---

# The header's line changes miss a subagent's edits until the parent transcript is written

## What happens

The header's line count is recounted on transcript activity in the session's
working tree (spec [[2026-09-30-branch-pr-and-line-changes-design]] § When it
refreshes). That activity comes from the projects watcher's batches in
`server/src/index.ts`, and the watcher's event filter
(`projectsEventTarget` in `server/src/watcher/projects.ts`) drops
`<project>/<session>/subagents/*.jsonl`.

So while a subagent is editing files, nothing triggers a recount. The count
catches up when the parent transcript is written next, or when the index
moves (a `git add` or a commit). During a long subagent run the number is
stale.

## Why it was not fixed with the feature

It needs the subagent file mapped back to its parent session, and the
watcher's filter is shared with the indexer, which must keep ignoring those
files. The staleness is bounded by the parent's next write.

## Fix

Let the lines trigger (not the indexer) also hear subagent transcript writes,
mapped to the parent session's `cwd`. The store's debounce already absorbs
the extra events.
