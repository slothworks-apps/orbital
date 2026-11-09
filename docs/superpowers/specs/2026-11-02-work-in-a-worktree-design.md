---
id: 2026-11-02-work-in-a-worktree-design
title: Work in a worktree — Orbital makes the worktree before a session starts
type: spec
status: done
domain: sessions
related:
  - a-session-has-a-home-and-a-working-tree
  - orbital-makes-the-worktree-and-names-its-branch
  - 2026-10-07-live-working-tree-design
tags:
  - git
  - worktree
  - new-session
  - ui
---

# Work in a worktree

Design: Claude Design, `Feature - Work in a worktree.dc.html`, artboards
63a–63h. Where this spec and the canvas disagree, this spec wins. Each
difference is listed under [Differences from the canvas](#differences-from-the-canvas).

## Why

Several sessions often work in one repository at once. When they share the
main checkout, they switch each other's branch and mix their uncommitted
files. Today the user has to remember to tell a session "work in a worktree".
They usually remember too late, after the session has already written into
the shared checkout. A session sometimes makes a worktree on its own, but not
reliably.

Orbital knows which live sessions work in which checkout. So it can create
the worktree itself, before the session's first turn, at the moment the
worktree matters: when another session already works there. The session then
starts inside the worktree and cannot miss it. It is also told where it is,
so it knows.

## Scope

- **For:** anyone who runs more than one session in a repository.
- **Where it lives:** on by default, not in Labs. The WORKTREE group appears in
  New Session whenever the chosen directory is a git repository.
- **What an existing user notices after updating:**
  - New Session is wider and has two columns (see [Two-column dialog](#two-column-dialog)).
  - When the directory they pick already has a live session in its checkout,
    the switch is already on and names that session.
  - Ending a session that works in a worktree offers to remove the worktree.
  - In New Session, PROFILE and TAG sit in the right column, and an account
    with more models than fit in two rows of tiles picks its model from a
    dropdown.
  - The switch starts as they last left it in that repository.
- **What can be set:** Settings → Sessions.
  - *Offer a worktree when another session works in the checkout* (key
    `worktree_auto_on_when_occupied`, on by default). Off, the switch in the
    dialog starts as the user last left it in that repository. On, an
    occupied checkout starts it on whatever was left.
  - *Files to copy into a new worktree* (key `worktree_copy_patterns`); see
    [Launch](#launch), step 4.
- **Out of scope:**
  - moving a running session into a worktree;
  - removing a worktree without the user pressing a button;
  - creating worktrees for sessions started in the terminal (they are shown,
    not driven).

## Two-column dialog

New Session widens to the canvas's 920 px and gets two columns. On the left is
*where* the session runs: DEVICE, PROJECT DIRECTORY, WORKTREE. On the right
is *how* it runs: PROFILE, MODEL, PERMISSION MODE, TAG. PROFILE heads the
column because it decides which models are offered. FIRST PROMPT spans both
columns, so nothing in the dialog scrolls (63a). The two columns help every
user, not only this feature.

MODEL stays tiles while every model plus Other fits in two rows of four.
Past that it is one dropdown field, the shape of DEVICE, listing name and
context, Other last. The list stops at eight and a half rows. The
choice is made again for each profile's catalog; a switch fades one picker
out and the other in while the slot eases to its new height. The canvas
lists a price on each row; the app has none to show (`ModelCards`).

It ships in the same PR as the worktree.

## The WORKTREE group (desktop, 63a–63c)

It sits under PROJECT DIRECTORY. It is shown only when the directory resolves
to a git repository, on the device in DEVICE. A non-git directory or a
missing directory shows nothing. The answer arrives after the dialog is
open, so the group unfolds by its height rather than appearing at once.

### States

- **Quiet (A1).** The repository is free: no live session has its working
  tree in the main checkout. The group is one line with a switch, *Work in a
  worktree*, as the user last left it in this repository (its main checkout,
  on that Mac or server): off until it was once left on. Each app keeps its
  own memory of it: the Mac's dialog and the phone's form do not share it.
- **Occupied (A2).** At least one live session has its working tree in the
  main checkout. The switch turns on when the directory is chosen, as long as
  the setting above is on. Under the switch, one muted line names the session
  and the branch the checkout is on: "Fixing tray flicker is working here on
  fix/tray-flicker." The session's tag dot is the only colour in the line.
  Switched off by hand, the line stays and adds once: "This session would
  share its branch and files."
- **On (A3).** BRANCH and BASE unfold under the switch.

A *live* session is an Orbital session whose status is anything but
`ended`. Terminal sessions do not count: Orbital shows them but does not
drive them. A running subagent of a live session counts as well, when it
works in the main checkout. The lookup is `WorkingTrees.sessionsAt`.

### BRANCH

The field is optional. Its placeholder shows the form the repository's branch
names use, for example `feat/…`. The form is the most common prefix among
the repository's recent local and remote branches, falling back to `feat/`.
No model is called while the user types; the canvas's ⇥-takes-a-suggestion
is dropped.

- **Typed:** the name is used as written.
- **Left empty:** Orbital names the branch at launch (see [Launch](#launch)).

The field is checked as the user types. A name with spaces gets "Branch names
can't contain spaces." A name that already exists, locally or on the remote,
gets "<name> already exists. Pick another name, or base on it." with the
action *Base on it*. That action makes the existing branch the base and
clears BRANCH. While either error stands, Launch waits.

### BASE

The default is `origin/main`, or whatever the repository's default branch on
`origin` is. The value shows as `origin/main · fetched`. Turning the switch on
runs `git fetch origin` once for that repository. If the fetch fails, the
field gets "Couldn't fetch origin. You seem to be offline." with the action
*Use local main*. Once local main is picked, the field shows its age
("local · 2 h old").

The picker uses the shell of every other dropdown (63c). Its rows, from top:

1. **MAIN CHECKOUT IS ON NOW.** The branch the main checkout is on, when that
   branch is not the default branch. The row names the session working there
   ("Fixing tray flicker · stack on its work"). This is the row for stacked
   PRs.
2. **DEFAULT.** `origin/main`.
3. **Search** over local and remote branches.

When the base is not the default branch, one neutral line under the group
says "The PR will target <base>, not main."

### The footer summary

With the switch on, the summary line under the fields reads "<model> ·
<mode> · worktree <name> from <base>". When the branch is left empty, it
reads "… · Orbital names the branch at launch".

## Launch

`POST /api/sessions` gains an optional `worktree` object:

```ts
worktree?: { base: string; branch?: string }
```

When the object is present, the server does the following before
`runner.start`, in order:

1. **Name the branch,** when `branch` is empty. One one-shot model call, the
   same kind the titler makes (Haiku, `maxTurns: 1`, no tools, no settings).
   It gets the first prompt and up to `BRANCH_FORM_SAMPLES` recent branch
   names as examples of the form. It returns a branch name and a session
   title. The title goes to the titler, which then skips its own
   first-message call for this session.
   - The reply is checked: a valid ref name (`git check-ref-format`), and at
     most `MAX_BRANCH_CHARS` characters. A name that already exists gets
     `-2`, `-3` and so on.
   - When the call fails, takes longer than `BRANCH_NAME_TIMEOUT_MS`, or there
     is no first prompt, the branch becomes `claude/<first 8 characters of the
     session id>`. The session is then told to rename it before its first
     commit. The failure is recorded in the error log, never shown.
2. **Create the worktree:** `git worktree add -b <branch>
   <repo-root>/.claude/worktrees/<leaf> <base>`. The directory name `<leaf>`
   is the last segment of the branch name, with `-2` and so on added when the
   directory already exists. `<repo-root>` is the root of the main checkout,
   even when the dialog's directory is a subdirectory of it.
3. **Record the PR target,** when the base is not the default branch:
   `git config branch.<branch>.gh-merge-base <base without origin/>`. Running
   `gh pr create` without `--base` reads this value. It also survives a
   restart, so the session's instructions can be rebuilt from it.
4. **Copy the local files git does not track,** from the main checkout into
   the new worktree, at the same relative paths:
   - always `CLAUDE.local.md` and `.claude/settings.local.json`;
   - plus whatever matches the patterns in Settings → Sessions → *Files to
     copy into a new worktree* (key `worktree_copy_patterns`, gitignore
     syntax, one per line, empty by default, for example `.env*`).

   The patterns are a setting on the device, not a file in the repository,
   so nothing about them is versioned. A missing file is skipped without a
   word. The `.mcp.json` decisions taken in the dialog are recorded against
   the worktree's path as well as the dialog's directory.
5. **Keep the worktrees out of `git status`.** When the main checkout does not
   already ignore `.claude/worktrees/`, add it to `.git/info/exclude`. That
   file is local and never committed. Otherwise every worktree would show as
   untracked in the main checkout and count as uncommitted work there.
6. **Start the session** in the worktree. When the dialog's directory is a
   subdirectory of the repository, the session starts in the same
   subdirectory inside the worktree, for example `…/worktrees/x/server` for
   `~/repo/server`.

When the dialog's directory is itself a linked worktree, the new worktree
still goes under the main checkout's `.claude/worktrees/`. The occupancy check
and the *MAIN CHECKOUT IS ON NOW* row then describe the tree that was picked,
not the main checkout. "Occupied" covers every live session whose working
tree is that tree, at its root or in any subdirectory.

Any failure in steps 2, 3 or 5 aborts the launch. No session row is created, and
the dialog shows the error inline, as A4 shows. A worktree left behind by a
failed launch is removed again.

The dialog's *Launch* stays a single button. The launch is pending until step
4 is done. Naming the branch adds about a second to it.

**Another device.** The `worktree` object travels with the body that
federation already re-posts to the member's `/api/sessions`. The member runs
the same steps against its own repository. The group's lookups described next
go to the member the same way, through `machine`.

### Routes the dialog needs

- `GET /api/worktree/options?cwd=&machine=` returns:
  - `{ git: false }` for a directory that is not a git repository;
  - otherwise `{ git: true, repoRoot, defaultBranch, mainCheckoutBranch,
    occupants: [{ sessionId, title, tagId }], branchForm, branches: { local,
    remote } }`.
- `POST /api/worktree/fetch { cwd, machine? }` returns `{ ok, fetchedAt }`, or
  `{ ok: false, error: 'offline' | 'auth' | 'other' }`.

Both are added to the phone's allowlist in the `spawn` group.

## What the session is told

`composeAppendix` gains one more input: the session's working tree, read from
`WorkingTrees`. It is composed at every start, resumes included, so nothing
needs to be stored. When the working tree is a linked worktree, whoever
created it, the appendix adds:

> You run in the worktree `<path>` on branch `<branch>`.

When `branch.<branch>.gh-merge-base` is set, it adds: "Its pull request
targets `<gh-merge-base>`." The sentence informs the session; it does not
tell it to open a PR.

When the branch is the `claude/<id>` fallback, the appendix adds one more
sentence: "This is a temporary name: rename the branch to fit the work
(`git branch -m`) before your first commit."

The appendix closure therefore takes the session as an argument; today it
takes none.

## The home of a worktree session

The session's `cwd`, which is its *home*
([[a-session-has-a-home-and-a-working-tree]]), is the worktree's path.
Tags still match it: tag rules are unanchored regular expressions, so a
rule for `~/work/orbital` also matches `~/work/orbital/.claude/worktrees/x`.

RECENT in New Session must not fill up with worktree paths. When a recent
directory lies under `<repo>/.claude/worktrees/`, the pill shows the
repository root.

## Removing the worktree

Removal is offered for **any** session whose working tree is a linked
worktree, whoever created it. The user decides each time; *Keep* is always
one press away.

### The worktree's state

`GET /api/sessions/:id/worktree` returns:

```ts
{
  path, branch,
  pr: { number, state } | null,  // from the branch status store
  uncommittedFiles,              // git status --porcelain, line count
  unpushedCommits,               // rev-list --count @{u}..HEAD, or HEAD --not --remotes without an upstream
  sharedWith: string[],          // other live sessions in the same tree (WorkingTrees.sessionsAt)
}
```

It returns `null` when the working tree is not a linked worktree, and also
when it no longer exists.

### The variants (63f)

| | when | the line | the buttons |
|---|---|---|---|
| **C1** | nothing local would be lost | "Branch stays on GitHub · PR #n open" (or merged / closed) | Keep · **Remove** (filled) |
| **C2a** | uncommitted files | "3 files uncommitted" | **Keep** (filled) · *Discard, remove* (soft error ink) |
| **C2b** | unpushed commits, clean tree | "2 commits unpushed · branch stays on this Mac" | **Keep** (filled) · Remove |
| **C3** | another live session is in the tree | nothing is offered | — |

The order is always Keep, then Remove; only which button is filled changes.
Remove runs `git worktree remove <path>`. *Discard, remove* adds `--force`.
The local branch is never deleted.

### Where it is offered

1. **In End session's confirmation** (`EndDialog`). This is the main place.
   When the session works in a worktree and C3 does not apply, the dialog
   gains a row: "Also remove worktree <leaf>" plus the variant's line. It starts
   checked only in C1 with a merged or closed PR, when the work is done.
   Otherwise it starts unchecked, so a session waiting on review keeps its
   folder. In C2, checking it says what is lost.
   Ticking the box in C2a turns the line to "Discards 3 uncommitted files"
   in the soft error ink, and the End button to *End and discard* (63h).
   `POST /api/sessions/:id/end` gains `removeWorktree?: 'clean' | 'force'`
   and `worktreePath`, the path the row showed; another path now is refused
   with `worktree_state_changed` before anything ends. Ending with the box
   unticked counts as *Keep*: the strip does not come back for that
   worktree.
   **Removed after End answers.** The answer comes once the checks pass and
   the session has ended; it does not wait for git. Waiting for the
   process to stop and deleting the tree (a `node_modules` included) took
   long enough that the confirmation held the user up. The server then
   waits for the process and removes the worktree on its own. Until it is
   gone, the worktree's state reads `null`: no row, strip or ⋯ entry offers
   it a second time. A removal git refuses is recorded in the error log,
   whose record raises the desktop's error toast, and the worktree is
   offered again. The answer is 200 `{ ok: true }`, or `worktreeRemoved:
   false` with `not_worktree` for a session no longer in a worktree. A Mac
   before this answered after git, with `worktreeRemoved: true` or
   `worktree_failed`; the web still reads both.
   The session's title sits on its own line above "Stops and moves to
   history…" (63h, 63i), so a long one does not break the sentence. From the
   moment End is pressed until the answer, the row holds what it showed:
   the server ends the session before it answers, and the worktree read
   again on that status change must not move the tick. The End button reads
   *Ending…*; Cancel, the row and the key hint dim and wait, and esc (on the
   phone, a tap on the backdrop or back) does nothing.
2. **A strip in the detail panel** (63e). It is 46 px tall, directly under the
   where row, and never in the transcript. It is shown only for an ended
   session whose branch is pushed and has a PR (open, merged or closed), and
   only when C3 does not apply. A live session never shows it, so the
   transcript does not jump; removal stays in End and in ⋯. *Keep* hides the
   strip for that worktree for good; the dismissal is remembered on the
   server, keyed by the worktree's path. It hides only the strip: End
   session's confirmation still offers removal, and ⋯ → *Remove worktree*
   stays available.
3. **⋯ → Remove worktree** in the panel's menu. It is always present for a
   worktree session, opens the same choice as the strip, and is disabled
   in C3.

**A session that has not ended.** Removing its worktree would leave its next
turn in a deleted directory. So:

- For an Orbital session, the menu says *End and remove*. The request
  carries the choice the user saw (`endSession`) and the path they
  confirmed. When either no longer matches the session's state, the server
  refuses with `worktree_state_changed` instead of ending a session nobody
  confirmed ending. Then it ends the session first and removes the worktree
  second, the same order as `removeWorktree` on end.
- A terminal session that is still live is not offered removal: Orbital
  cannot stop it. It becomes eligible once it has ended.

Removing a worktree under an ended session leaves the session's `cwd`
missing. Resuming it then shows the existing missing-directory flow.

## The phone

The phone gets the feature too (63g). Spawning already reaches it: the
phone's New Session posts to the same `POST /api/sessions`.

- **New Session:** under DIRECTORY, the same WORKTREE group, as a grouped list:
  the switch row, then BRANCH and BASE as 52 px rows. BRANCH is edited in
  place. BASE opens a sheet in the `BranchSheet` shell, with its rows in the
  same order as the desktop picker. The auto-on and the hint line are the
  same as on the desktop.
- **Session screen:** the cleanup row sits at the end of an ended session's
  transcript, under the same rule as the desktop strip. It never opens by
  itself.
  Tapping it opens a sheet with the same two choices. The phone's End
  confirmation gains the same row as `EndDialog`.
- **Allowlist:**
  - `spawn` group: `GET /api/worktree/options`, `POST /api/worktree/fetch`;
  - `sessions` group: `GET /api/sessions/:id/worktree`, `POST
    /api/sessions/:id/worktree/remove`, plus the new end body field.
- **Slow routes over the tunnel:** a worktree launch and a fetch can take
  longer than a tunnel request's usual wait, so the channel waits longer for
  them (`slowRequestTimeoutMs` in `shared/src/worktree.ts`). A launch whose
  answer was lost anyway can be sent again with the same session id: the
  server answers a repeat with the first launch's answer instead of making a
  second session and worktree.
- **An older Mac:** the group is gated in `MAC_FEATURES` as `worktreeLaunch`,
  with the desktop version this ships in. Against an older Mac, the phone
  hides the group and the cleanup row.

## Differences from the canvas

These are decisions taken after the canvas was drawn:

- Not in Labs. The canvas puts the feature in Labs; it ships on by default,
  with the setting above.
- There is no suggested branch name in the placeholder and no ⇥, only the
  form. Naming happens at launch, so the session starts on its final branch.
  The canvas's "session renames claude/… before its first commit" remains as
  the fallback only.
- "Made by Orbital at launch" (63d) and the rule that only Orbital's
  worktrees are offered for removal are dropped. Every worktree is offered,
  and nothing is stored about who made it.
- The canvas offers cleanup when a session ends or is archived. Orbital's
  ending is *End session*, so cleanup is a row in its confirmation. The panel
  strip appears on an ended session whose branch is pushed and has a PR.
- DEVICE is in scope: the canvas does not draw it, and the group works for
  every device.
- 63h's rule note says the End row appears only for a worktree Orbital made.
  Like the rest of the cleanup, it appears for every linked worktree.
- 63h ENDING… dims the disabled End and Cancel to .45; they keep the app's
  shared disabled look (.40), as every other disabled button does. The row's
  hairline and well stay as they are; its checkbox and label dim.

- The model cards use a slightly smaller name, and the selection pip sits on
  the second line, so names like "Sonnet 5.5" are not cut off. (PROFILE and
  TAG first shipped in the left column, for fear that a long model list would
  make the dialog scroll at 1440×900. The list runs to two rows in practice,
  and they moved to the right column, as 63a draws them.)

## Tests

- **Branch name validation and collision suffixes:** a pure function.
- **Choosing the cleanup variant** (C1, C2a, C2b, C3) from the worktree state:
  a pure function.
- **Choosing the branch form** from a list of branch names: a pure function.
- **`POST /api/sessions` with `worktree`,** against a temporary repository:
  - the worktree is created at the expected path, the branch comes from the
    base, and `gh-merge-base` is set;
  - a failure leaves no worktree and no session row;
  - the naming fallback works when the model call fails.
- **`GET /api/sessions/:id/worktree`** reports uncommitted and unpushed work
  correctly.
- **`removeWorktree` on end** removes the worktree and keeps the branch, and
  without `force` it refuses a dirty tree.
- **The allowlist** covers the new routes.

## Shipping

- One PR: the two-column New Session and the worktree together.
- It reaches the desktop and the phone (`web/src/mobile`).
- Proposed version bumps: desktop minor; phone app version minor; no native
  change.
- Changelog lines go in `desktop/CHANGELOG.md` and `mobile/CHANGELOG.md`.
