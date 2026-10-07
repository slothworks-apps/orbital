---
id: a-file-link-resolves-against-the-cwd-it-was-written-in
title: A file link resolves against the cwd it was written in
type: adr
status: in-force
domain: files
related:
  - 2026-10-07-live-working-tree-design
  - 2026-10-03-api-token-and-named-files-design
tags:
  - files
  - security
  - worktree
---

# A file link resolves against the cwd it was written in

## The problem

The viewer resolves a relative path against the session's `cwd`, and the
whole confinement rests on that `cwd`. When the agent works in a worktree,
`docs/x.md` means the worktree's file. Resolved against the main checkout,
it either answers "not found" or opens a different version of the same
file without saying so.

## The decision

The client sends the `cwd` of the transcript entry the link came from. The
server accepts it only when the session's transcript or one of its
subagents' transcripts has recorded that `cwd`, and then confines the read
to it the same way it confines to the session's `cwd` today. A `cwd` the
transcripts never named is ignored. Without one, the server tries the
session's current working tree, then its home.

The sandbox grows only by directories the agent itself worked in. The
agent could read them anyway, so showing them to the user discloses nothing
new.

## What was ruled out

- **Trying every tree the session touched until one has the file.** It
  needs no client change, but when both trees have the file, the first tree
  in the list wins. That is the silent wrong version this decision exists
  to prevent.
- **Accepting any `cwd` the client sends.** That would turn the parameter
  into a way past the sandbox.
