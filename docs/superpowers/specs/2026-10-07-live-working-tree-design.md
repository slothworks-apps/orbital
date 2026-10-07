---
id: 2026-10-07-live-working-tree-design
title: The header and the file viewer follow the tree a session works in now
type: spec
status: draft
domain: sessions
related:
  - git-location-is-ambient-not-recorded
  - a-session-has-a-home-and-a-working-tree
  - a-file-link-resolves-against-the-cwd-it-was-written-in
  - 2026-09-22-git-location-indicator-design
  - 2026-09-30-branch-pr-and-line-changes-design
  - 2026-10-03-api-token-and-named-files-design
tags:
  - git
  - worktree
  - files
  - subagents
---

# The header and the file viewer follow the tree a session works in now

## The problem

A session's `cwd` is the first `cwd` its transcript records
(`extractMeta` in `server/src/transcript/parser.ts`), and it never moves
after that. The transcript itself does move: every entry carries the `cwd`
it ran in, and after `EnterWorktree` the entries name
`<repo>/.claude/worktrees/<name>`, sometimes a subdirectory of it
(`…/<name>/web` after a `cd`). Subagents launched with
`isolation: "worktree"` run in a worktree of their own and their
transcripts say so; the server does not read them.

Two things go wrong because of it:

- **The header names the wrong branch.** The git location
  ([[git-location-is-ambient-not-recorded]]) is read for the first `cwd`,
  so a session that moved into a worktree shows the main checkout's branch,
  typically `main`. The same goes for the PR and line-change suffixes and
  for the phone's `⎇ ref`.
- **A file link the agent wrote does not open.** The viewer resolves a
  relative path against the first `cwd`. A file that exists only in the
  worktree answers "not found". Worse, a file that exists in both trees
  opens from the main checkout, which is the wrong version, and nothing on
  screen says so.

## What changes for the user

- The header's path and branch are those of the tree the session works in
  now. After `EnterWorktree` the header reads the worktree's branch with the
  worktree mark, within a beat of the transcript line that moved it.
- When running subagents work in trees other than the session's own, the
  header shows how many after the branch, e.g. "+3 worktrees". Hovering
  lists them, one row per tree: the branch, the worktree's directory name,
  and the subagents running in it. The count covers only subagents that are
  running now. When the last one in a tree ends, that tree leaves the count,
  and an ended session shows no count.
- A file link in the transcript opens the file from the tree in which the
  agent wrote it, whether that was the session's own line or a subagent's.

## Design

### 1. A session has a home and a working tree

`cwd` keeps its meaning: it is the session's **home**. It decides the
project, the cluster on the map, the tags and the title fallback, and it
does not move. Next to it, the server keeps where the session works **now**
([[a-session-has-a-home-and-a-working-tree]]):

- **The session's current `cwd`** is the last `cwd` in its main transcript.
  The indexer already reads the transcript as it grows; it keeps the last
  `cwd` it saw in memory, keyed by session id. No column, no migration: this
  is live state, the same as `status`. On a server restart the first read of
  the transcript fills it again.
- **Each subagent's current `cwd`** is the last `cwd` in its own transcript
  (`<session>/subagents/agent-<id>.jsonl`), read the same way and kept on
  the subagent tracker's `SubagentInfo`.

Both are resolved to their **working-tree root** through `GitStore.rootOf`,
so a `cd web` inside a worktree does not count as a different place. A `cwd`
outside any repository stays as it is and has no git location.

### 2. What the session shape carries

`toApiSession` (`server/src/api/shape.ts`) changes in three places:

- `git` and `branch` (the PR and line counts) are read for the **current**
  tree instead of `row.cwd`. They keep the same types, so the header, the
  sidebar and the phone show the right branch without a change of their
  own.
- A new `workingDir: string` is the current tree's root, or the current
  `cwd` when it is outside a repository. The header shows it as the path.
  When it equals the home, nothing looks different from today.
- A new `otherTrees: Array<{ root: string; git: GitLocation | null; agents: string[] }>`
  lists the trees in which **running** subagents work, minus the session's
  own current tree. `agents` holds those subagents' names. It is empty for
  an ended session and for a session whose subagents all share its tree.

`ide.locate` and the `@` completion follow `workingDir` too, so `@` in the
composer completes against the tree the agent will read from.

### 3. When it refreshes

- A transcript line with a new `cwd` (main or subagent) republishes the
  session the way a status change does, through the existing
  watched-sessions path ([[ambient-changes-republish-only-watched-sessions]]).
  A line with the same `cwd` as the one before costs nothing.
- `GitStore` already watches `HEAD` per working-tree root. A new root is
  registered on its first `locate`, and the reverse index (`cwdsFor`) now
  maps it to the sessions that work there now, not only to their homes.
- A subagent that ends drops out of `otherTrees` through the same tracker
  update that ends it today.

### 4. A file link resolves against the `cwd` it was written in

([[a-file-link-resolves-against-the-cwd-it-was-written-in]])

- Transcript items the client renders carry the `cwd` of the entry they
  came from, for the main transcript and for subagent transcripts alike.
- When a path in that item is pressed, the client sends the `cwd` along:
  `GET /api/files?session=…&path=…&cwd=…`, the same on `/api/files/image`
  and on the phone's `file_get` (an optional field in
  `shared/src/remote/messages`, so an older phone and an older Mac keep
  working without it).
- The server accepts that `cwd` only if the session's own transcript or one
  of its subagents' transcripts has recorded it. Then it confines the read
  to that `cwd` exactly as `resolveInsideCwd` confines it to the home today.
  A `cwd` the transcripts never named is ignored and the request falls back
  as if none had been sent.
- Without a `cwd` (an older client, or a path typed by hand), the server
  tries the session's current tree first, then the home. The first one that
  has the file answers.
- The absolute-path widening of
  [[2026-10-03-api-token-and-named-files-design]] stays as it is.

### 5. The header

The header's first line (`web/src/panels/WhereLine.tsx`) reads `workingDir`
for the path, and draws the `otherTrees` count after the branch and its
suffixes, with a tooltip listing the trees. Its look and its place in the
row's width split come from Claude Design. The prompt to bring there:

> Detail panel header, first line (`Feature - Git worktree` 1a/1f,
> `Feature - Branch status`). Add a read-out for "running subagents are
> working in N other git trees", e.g. `+3 worktrees`. It sits after the
> branch and its suffixes (#PR, line changes) and has to fit the existing
> fold rules (23c/23d). It is not a button. A hover tooltip lists each tree
> on one row: worktree mark, branch, the worktree directory name, and the
> names of the subagents running in it, up to 5 trees then "+N more".
> N=0 draws nothing. It is ambient orientation, not an alert: no colour of
> its own, no motion when N changes beyond the branch's existing fade.

### 6. Error handling

- A subagent transcript without a `cwd` line yet: the subagent has no tree
  and does not count.
- A worktree removed while a session still points at it: `GitStore` drops
  the entry when its `HEAD` watch fails (as today). The tree then has no git
  location: the row shows the directory without a branch, and the next
  transcript line moves the session on.
- A file request whose `cwd` is accepted but no longer exists answers
  `not_found`, the same as a deleted file.

### 7. Testing

- The parser and indexer keep the last `cwd`: entries that move into a
  worktree and into a subdirectory of it, and a transcript with no `cwd`.
- `otherTrees`: subagents in the session's own tree, in two other trees,
  one ended, and an ended session.
- File confinement: a `cwd` the transcripts named is accepted, one they did
  not is ignored, a relative path that exists in both trees is read from
  the given one, and the no-`cwd` fallback order.
- The header's tooltip and its fold are checked against the canvas during
  the work, not pinned in tests.

## The phone

The phone gets the corrected branch without work of its own: its session
list and session screen read `session.git.ref`, which now follows the
current tree. File links on the phone send the entry's `cwd` over
`file_get` the same way the desktop sends it over `/api/files`. The route is
already on the allowlist and the field is optional.

The "+N worktrees" read-out is left out of the phone on purpose. Its content
lives in a hover, and the phone's header line is a single `· ⎇ ref` that has
no room for a second read-out. If it turns out to be missed there, it
belongs in the phone's subagent list (each subagent row naming its branch),
not in the header. An `idea` records that.

## Out of scope

- A history of which trees a session has worked in. The header says where
  things are now, per [[git-location-is-ambient-not-recorded]].
- Moving a session to another project or cluster when it enters a worktree.
  Its home does not change.
