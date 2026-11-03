---
id: orbital-makes-the-worktree-and-names-its-branch
title: Orbital makes the worktree and names its branch before the session starts
type: adr
status: in-force
domain: sessions
related:
  - 2026-11-02-work-in-a-worktree-design
  - a-session-has-a-home-and-a-working-tree
tags:
  - git
  - worktree
  - sessions
---

# Orbital makes the worktree and names its branch before the session starts

## The problem

A session that should not share the main checkout has to end up in a
worktree, on a branch that fits its work, and it has to know both. Until
now that hung on an instruction in the prompt. The user often wrote it too
late, and the session sometimes ignored it.

## The decision

- **Orbital creates the worktree** in `POST /api/sessions`, before
  `runner.start`, and starts the session with the worktree as its `cwd`. The
  session cannot miss it.
- **Orbital names the branch at launch** when the user leaves it empty. It
  makes one one-shot model call on the first prompt, with the repository's
  recent branch names as examples of the form. The worktree is created
  straight on the final name. The temporary `claude/<id>` branch, with an
  instruction to rename it, is only the fallback for when that call fails or
  there is no first prompt.
- **The session is told where it is** by its system-prompt appendix. The
  appendix is composed at every start from the live working tree and from
  `branch.<name>.gh-merge-base`. Nothing about the worktree is stored in
  Orbital's database.
- **Every linked worktree is offered for removal,** whoever created it, and
  only on a press.

## What was ruled out

- **Telling the session to run `EnterWorktree`.** This is what the user did
  by hand. It depends on the model obeying, and the first turn can already
  write into the shared checkout.
- **Suggesting a branch name in the dialog while the user types.** It would
  need a model call on every pause in typing, for a value most users leave
  alone.
- **Always starting on `claude/<slug>` and letting the session rename it**
  (the canvas's first draft). The session knows the work better after a few
  turns, but this brings back the reliance on obedience. A session that
  commits or pushes before it renames leaves the temporary name on GitHub.
- **Recording which worktrees Orbital created,** so that only those are
  offered for removal. The user's worktrees all come from agents or from
  Orbital anyway. *Keep* is one press, and the uncommitted and unpushed
  checks guard against loss. A record would be state with nothing to gain.
- **Storing the PR target in a column.** `gh-merge-base` is git's own place
  for it: `gh pr create` reads it, and it survives restarts and travels with
  the branch.
