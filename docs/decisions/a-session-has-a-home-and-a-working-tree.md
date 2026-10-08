---
id: a-session-has-a-home-and-a-working-tree
title: A session has a home and a working tree
type: adr
status: in-force
domain: sessions
related:
  - 2026-10-07-live-working-tree-design
  - git-location-is-ambient-not-recorded
tags:
  - git
  - worktree
  - sessions
---

# A session has a home and a working tree

## The problem

A session's `cwd` is the first `cwd` its transcript records. After
`EnterWorktree` the transcript moves to `<repo>/.claude/worktrees/<name>`,
and its subagents can run in worktrees of their own. The header and the
file viewer read the first `cwd`, so they describe the main checkout while
the work happens somewhere else.

## The decision

The session keeps two places:

- **The home** is `cwd`, as today. It decides the project, the map cluster,
  the tags and the title fallback, and it does not move.
- **The working tree** is the working-tree root of the last `cwd` in the
  transcript, kept in memory and never written to the database. The git
  location, the branch status, the IDE lookup, `@` completion and the
  header's path follow it.

Subagents get the same reading from their own transcripts. Only running
subagents count in the header.

## What was ruled out

- **Overwriting `cwd` with the latest one.** It is simpler, but a session
  would jump to another project on the map when it enters a worktree, and
  its tags and grouping would follow a temporary directory.
- **Reading the location from the SDK's events.** That works only for the
  sessions Orbital spawns. Sessions started in the terminal write the same
  transcript, so the transcript is the one source that covers both.
- **Storing the working tree in a column.** It is live state, like
  `status`. A restart rebuilds it from the first read of the transcript
  ([[git-location-is-ambient-not-recorded]]).
