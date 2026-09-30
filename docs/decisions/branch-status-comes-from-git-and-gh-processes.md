---
id: branch-status-comes-from-git-and-gh-processes
title: Branch status comes from spawned git and gh processes
type: adr
status: in-force
domain: sessions
related:
  - 2026-09-30-branch-pr-and-line-changes-design
  - git-location-is-ambient-not-recorded
tags:
  - git
  - github
  - server
---

# Branch status comes from spawned git and gh processes

## The problem

The header is getting a PR indicator and a line-change count
([[2026-09-30-branch-pr-and-line-changes-design]]). Until now the server read
git by opening files under `.git` and never spawned anything. That is enough
for a branch name. It is not enough for a diff against a merge base, and it
cannot say anything about GitHub.

## The decision

- Line counts come from the `git` binary (`merge-base`, `diff --numstat`,
  `ls-files --others`).
- The PR comes from the `gh` CLI (`gh pr view --json …`), with the user's own
  `gh` login.
- The branch name and worktree kind keep being read from files, as before.
  Those are read on every `HEAD` move, and a spawn per move is not worth it.

## What was ruled out

- **Computing the diff in-process** (isomorphic-git or reading packs).
  It is a large dependency, and it would reimplement merge-base and rename
  detection that `git` already does correctly.
- **The GitHub REST API with a token Orbital stores.** Orbital binds to
  localhost with no authentication and has nowhere safe for a token. It would
  also ask the user to log in a second time. `gh` already holds a login and
  resolves the repository from the remote.
- **Reading the PR from `git` alone** (`refs/pull/*`). It has no review
  state or checks, and it needs a fetch.

## Consequences

- Without `gh` there is no PR indicator. Settings says why; the header just
  omits the indicator.
- The packaged app does not inherit the shell's `PATH`, so `gh` is also
  looked up on the Homebrew paths.
- Spawns are gated to directories someone has open and to settings that are
  on, so a user who never enables the feature pays nothing.
