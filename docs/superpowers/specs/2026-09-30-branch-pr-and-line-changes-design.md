---
id: 2026-09-30-branch-pr-and-line-changes-design
title: Pull request and line changes in the detail panel header
type: spec
status: draft
domain: sessions
related:
  - 2026-09-22-git-location-indicator-design
  - git-location-is-ambient-not-recorded
  - ambient-changes-republish-only-watched-sessions
  - branch-status-comes-from-git-and-gh-processes
  - 2026-09-21-settings-sections-design
tags:
  - git
  - github
  - settings
---

# Pull request and line changes in the detail panel header

## The problem

The header already says where a session works: the path, the branch, and
whether the directory is a worktree
([[2026-09-22-git-location-indicator-design]]). It does not say how far that
work has got. A developer running several agents on several branches wants
two more facts without leaving Orbital: is there a pull request for this
branch, and how big is the change.

Not everyone wants them, so both are opt-in.

## What the header shows

### Pull request

- The PR number, e.g. `#123`. A click opens the PR on GitHub in the system
  browser.
- The tooltip carries the rest:
  - state: open, draft, merged, closed;
  - review: approved, changes requested, review required, or none;
  - checks: passing, failing or pending, with counts
    (e.g. "12 passed, 1 failed, 2 running").
- No PR for the branch, or no answer from `gh` (see below): nothing is drawn.
  The header does not show an empty or error slot.
- A detached HEAD and the default branch have no PR lookup.

### Line changes

- `+added −removed` for what the branch brings against its parent, the
  uncommitted work included.
- The parent is the PR's base branch when a PR exists and the PR indicator is
  on. Otherwise it is the repository's default branch, which
  `server/src/git/gitState.ts` already resolves.
- The count is taken against the merge base of `HEAD` and the parent, so
  commits that landed on the parent after the branch forked do not count.
- Untracked files count as added lines. A file the agent just created
  and nobody has `git add`-ed yet is part of the change; leaving it out
  would make the number lie in exactly the case the feature is for.
  Binary files count as zero lines.
- On the default branch, or with a detached HEAD, there is no parent. The
  count is the uncommitted work alone.
- The tooltip always splits the total into committed and uncommitted.
- No changes at all: nothing is drawn.

## The canvas

`Feature - Branch status.dc.html`, status PROPOSAL. Artboards 1a (in situ,
interactive), 1b (variants at 560 px), 1c (the fold), 1d (worst case), 1e
(tooltips), 1f (does the number hint at state), 1g (Settings), 1h (parts,
rules, trade-offs). The canvas owns geometry, ink and timing; what follows
are the rules it settled that code has to honour.

- Both are suffixes on row 1 of the header, after the branch:
  path · mark · branch · #PR · lines.
- The PR number is neutral in every state (1f, N1). State, review and checks
  live only in the tooltip. It is a button: hover fill, pointer, focus ring,
  the tooltip opens on focus too and ⏎ opens the PR.
- The lines are a read-out, not a control: no hover fill, no cursor change,
  hover opens the tooltip. For keyboard and screen readers they are part of
  the where-cell's `aria-label`.
- A hollow ring means "uncommitted" and nothing else: split mode's second
  group, and the lone group on the default branch.
- The only colour is the transcript's diff pair. No new hue.
- Counts from 10 000 up are shortened (`12.4k`).
- A merged or closed PR is still shown while the branch exists.
- Values update in place with the branch's fade. A PR appearing or
  disappearing fades in or out, and the fold is re-measured after the fade.

### The fold order

When the row runs out of width, each step gives up the cheapest thing left
(1c, 1d):

1. the path yields from its head, down to its leaf;
2. split collapses to the total, the uncommitted part stays in the tooltip;
3. the strip folds, the shipped mechanism
   ([[the-header-strip-folds-on-the-path-width]]), now measured on the whole
   where-cell;
4. the branch is cut in the middle, down to a floor;
5. the lines leave the row and move into the branch's tooltip, which then
   shows the full branch name above them; the branch becomes hoverable;
6. last resort: path to "…", branch to a lower floor.

The PR number is never dropped. With both off, or nothing to show, the row
and its fold point are exactly today's.

## Settings

Appearance section, next to the other header settings:

| setting key | control | values | default |
|---|---|---|---|
| `header_pull_request` | toggle | on / off | off |
| `header_line_changes` | segmented | `off` / `branch` / `split` | `off` |

- `branch`: one total, committed and uncommitted together.
- `split`: the total plus the uncommitted part shown on its own. The tooltip
  splits it in both modes.
- When `gh` is unusable, the PR switch is disabled and drawn off, with a
  one-line reason under it: "gh is not installed", "gh is not logged in".
  The stored choice is kept: once `gh` works again the switch comes back
  as it was left. The reason comes from the server, checked when Settings
  opens and when the app regains focus (canvas 1g).
- The lines row needs only `git` and never disables.
- Both off: the server spawns nothing for this feature.

## Where the data comes from

The server spawns processes for it, the first time Orbital does so for git
(adr [[branch-status-comes-from-git-and-gh-processes]]).

- Lines:
  - `git merge-base HEAD <parent>`;
  - `git diff --numstat <merge-base>` for the total;
  - `git diff --numstat HEAD` for the uncommitted part;
  - `git ls-files --others --exclude-standard` plus a line count of each file
    for untracked files, capped by a named constant on file count and size.
- PR: `gh pr view <branch> --json
  number,url,state,isDraft,baseRefName,reviewDecision,statusCheckRollup`,
  run in the working tree root. Exit codes and stderr map to the three
  outcomes "no PR", "gh not installed" and "gh not logged in / no GitHub
  remote". The last two are reported to Settings; none are shown in the
  header.
- `gh` is looked up on `PATH` first, then on the Homebrew paths
  (`/opt/homebrew/bin`, `/usr/local/bin`). The packaged app launched from
  Finder does not inherit the login shell's `PATH`.
- Every spawn has a timeout. A timeout counts as "no answer" and keeps the
  last good value.

## When it refreshes

Only for directories that someone looks at. The rule is the one
[[ambient-changes-republish-only-watched-sessions]] uses: a window has a
session in that directory open (`session:<id>` has a subscriber).

Lines:
- when a panel opens on the directory;
- when `HEAD` or the index moves (the `GitStore` watcher, extended to the
  index, so a commit or `git add` from a terminal is picked up too);
- after a tool that edits files finishes, and at the end of a turn. Both are
  debounced: the recount runs after a quiet interval, with a maximum wait so
  that a long run of edits still updates as it goes. Both intervals are
  named constants.

Lines are local `git` reads and never touch the network.

PR:
- when a panel opens on the directory;
- when the branch changes;
- on a fixed interval while a panel stays open (a named constant, in the
  order of a minute);
- when the app regains focus.

Edits never trigger a PR lookup. Terminal sessions get both, because the key
is the directory, not the session.

## The wire

A branch status belongs to a working tree root, like `GitLocation`
([[git-location-is-ambient-not-recorded]]). It rides on the session the same
way `git` does, as an optional field filled only when the matching setting is
on:

```ts
interface BranchStatus {
  lines?: {
    parent: string | null;        // null: no parent, uncommitted only
    committed: { added: number; removed: number };
    uncommitted: { added: number; removed: number };
  };
  pr?: {
    number: number;
    url: string;
    state: 'open' | 'draft' | 'merged' | 'closed';
    review: 'approved' | 'changes_requested' | 'review_required' | null;
    checks: { passed: number; failed: number; pending: number } | null;
  };
}
```

The browser opens `pr.url` through the desktop shell's external-link path.

## Tests

- Parsing `git diff --numstat` output: binary files (`-\t-`), renames,
  paths with tabs or spaces.
- Parsing `gh pr view` JSON into `pr`, including a rollup with mixed check
  runs and status contexts, and the draft and merged cases.
- Mapping `gh` failures to "no PR", "not installed" and "not logged in".
- Picking the parent: PR base when known, default branch otherwise, none on
  the default branch or a detached HEAD.
- The debounce with its maximum wait (fake timers).
- The settings route accepting and rejecting the two new keys.

## Out of scope

- GitLab, Bitbucket and other forges.
- Creating a PR from Orbital.
- Showing PR or line changes on the map.
