---
id: 2026-09-22-git-location-indicator-design
title: Git location indicator in the detail panel
type: spec
status: done
domain: sessions
related:
  - git-location-is-ambient-not-recorded
  - tilde-expands-at-the-api-boundary
---

# Git location indicator in the detail panel

## The problem

Orbital exists for multitasking: several agents running at once, one map
saying what each is doing. What the map and the panel never say is *where*
an agent is doing it. The detail panel's header carries the session's `cwd`
and nothing else, so two sessions on the same project are indistinguishable
whether one of them is working in a worktree on its own branch or both are
sitting in the main checkout on `main`.

That matters because an agent can be sent to work in isolation — the worktree
is the whole mechanism for keeping two of them out of each other's files —
and right now the only way to tell whether that worked is to read the path
carefully and know what `.worktrees/` means.

## The canvas

`Feature - Git worktree.dc.html`, status PROPOSAL:

- **1a** — in situ on row 1 of the header, interactive: pick a state, drag
  the panel width, switch branch.
- **1e** — the mark, five ways. **M1 (trunk / fork / tree) is chosen**; M2
  path-only, M3 hue, M4 the word "WORKTREE" and M5 a boxed branch are drawn
  and ruled out.
- **1f** — geometry, the width split, the live update, and the not-a-repo
  rule.

## What it shows

A suffix to the path on the same line — `path · mark · branch`, mono 11px.
The **mark** carries the distinction, by shape rather than by hue or length:

| the directory is | mark | the reading |
|---|---|---|
| main working tree, on the default branch | trunk | `main` |
| main working tree, on any other branch | fork | `feat/desktop-tray` |
| a linked worktree (`git worktree add`) | tree | `tray-mode` |
| on a detached `HEAD` | trunk | the 7-character sha |
| not inside a repository | — | no suffix at all |

The trunk/fork split is the canvas's addition (1e, M1): one stem for the
default branch, a stem with one branch leaving it for a feature branch, and a
tree — several branches, each ending in a node — for a worktree. It costs the
server a default-branch lookup that the rest of this spec has to provide.

Deliberately out of scope, and not to be added without a new agreement:
working-tree cleanliness, ahead/behind counts, collision warnings between
sessions sharing a checkout, and any click action. The indicator is a
read-out — no cursor change, no hover fill, no menu. The map, the sidebar and
the planet labels show no git state at all.

## Where the value comes from

Git state is a property of a **directory**, not of a session — several
sessions can share one `cwd`, and several `cwd`s can sit inside one
repository. The server therefore keeps one store keyed by repository root,
not by session. See adr `git-location-is-ambient-not-recorded` for why the
value is read live rather than recorded on the session row.

### Reading it

No `git` process is spawned. 1f suggests `rev-parse --git-dir` against
`--git-common-dir`; the same signal is in the files git already maintains,
which are also the files that have to be watched anyway:

1. Walk up from `cwd` until an entry named `.git` exists. Nothing found
   before the filesystem root means no repository, and the answer is null.
2. `.git` is a **directory** → this is the main working tree. `HEAD` is
   `<root>/.git/HEAD`, and that directory is also the common git dir.
3. `.git` is a **file** → this is a linked worktree. Its content is
   `gitdir: <abs path>/worktrees/<name>`; `HEAD` is `<that dir>/HEAD` and the
   common git dir is its grandparent.
4. Read `HEAD`. `ref: refs/heads/<name>` gives the branch; a bare
   40-character hex object id means detached, and the reading is its first 7
   characters.

Walking up handles the common layout without a special case: from
`<repo>/.worktrees/tray` the first `.git` found is the worktree's own file,
not the repository's directory further up.

### The default branch

Only needed to choose between trunk and fork, and only for the main working
tree. In order:

1. `<common git dir>/refs/remotes/origin/HEAD` — a symref file reading
   `ref: refs/remotes/origin/<name>`;
2. the same ref inside `<common git dir>/packed-refs`;
3. neither present → `main`, then `master`, by name.

A repository with no remote and a differently-named trunk therefore draws a
fork where a trunk belongs. That is the accepted failure: the mark it gets
still says "main checkout", which is the distinction the feature is for, and
the alternative is spawning `git` on a path that has to stay a cached file
read.

### Keeping it fresh

A branch switch rewrites `HEAD`, so `HEAD` is the watch target. `GitStore`
starts one chokidar watch per distinct repository root the first time that
root is resolved, and the watch invalidates the cached reading. `chokidar` is
already a dependency and already used this way in
`server/src/watcher/registry.ts`.

The number of watches is bounded by the number of distinct repositories the
user has sessions in — tens, not thousands. A watch is dropped when its
`HEAD` disappears (the worktree was removed, the repository deleted); the
next read re-resolves from scratch.

### Caching

Two maps, both on `GitStore`:

- `cwd` → repository root (or null), because resolution walks the filesystem
  and every `toApiSession` call would otherwise repeat it;
- repository root → the reading, invalidated by the watcher.

The store also keeps root → the set of `cwd`s that resolved to it, which is
what turns a `HEAD` change back into the list of sessions to republish.

A shaped session costs two map lookups on a warm cache, which is what makes
it affordable to put the value on every session in a list response rather
than behind a per-session endpoint.

## The wire

One new field on `ApiSession` (`server/src/api/shape.ts`, mirrored in
`web/src/lib/types.ts`):

```ts
export interface GitLocation {
  /** Branch name, or the 7-character sha when `detached`. */
  ref: string;
  /** HEAD points at a commit, not at a branch. */
  detached: boolean;
  /** The directory is a linked worktree, not the main working tree. */
  worktree: boolean;
  /** `ref` is the repository's default branch — the trunk/fork mark. Always
   *  false for a worktree or a detached HEAD, neither of which draws it. */
  defaultBranch: boolean;
}

// on ApiSession:
/** Where this session's `cwd` sits in git right now, or null when it is not
 *  inside a repository. Live state of the directory, not a record of the
 *  session (adr git-location-is-ambient-not-recorded). */
git: GitLocation | null;
```

The server sends the facts, not the mark: the browser picks trunk, fork or
tree from `worktree` / `detached` / `defaultBranch`.

`toApiSession` fills the field from `ctx.git`, alongside the live values it
already pulls from `ctx.runner`, `ctx.registry` and `ctx.subagents`. Reads
are synchronous cached file reads, so a session always arrives with its git
state resolved — there is no "still loading" state for the panel to hold, and
1f's fade-in-after-100 ms rule is satisfied by never having the gap it covers.

When a watched `HEAD` changes, `index.ts` invalidates the root and calls the
existing `publishSession` for every session whose `cwd` resolved to it, so
the change reaches open panels over the `sessions` topic that is already
subscribed. No new topic, no new event type.

## The panel

Row 1 of the header keeps its height, its ink range and its icon group. The
suffix goes in after the path, inside the same flexed element, with the
spacer and the four icon buttons unchanged after it.

**The width split (1f).** Both in full when they fit. Then the path yields
first, truncated from the head and snapped to a `/` (`…/auth-service`), down
to a floor of 14 characters. Then the branch yields, cut in the middle
(`feature/int…questions`), down to a floor of 10. The branch is capped at 24
characters even when there is room, so a long name can never eat the path.

The path yields first because it does not change and is echoed in the planet
label, the title and the tooltip, while the branch changes and is shown
nowhere else — and in a worktree the path's leaf usually *is* the branch
name, so cutting it costs almost nothing.

**This changes shipped behaviour.** Today the header renders
`shortenPath(cwd)` and lets CSS clip the tail. It gains a width-aware
truncation instead, computed from the panel width the store already holds.
`shortenPath` itself is not touched: the sidebar, the new-session dialog and
the stats project filter keep it exactly as it is. The new helpers are pure
functions beside it in `web/src/lib/format.ts`.

**Truncation is announced, not hidden.** A middle-cut branch shows its full
name in a tooltip on hover — no delay, no cursor change. One element carries
the whole reading as its `aria-label`: *"Worktree · branch tray-mode ·
~/P/orbital/.worktrees/tray-mode"*.

The bubble is a `name` variant added to `ui/Tooltip`, not a native `title`
and not a local copy: the OS draws `title` itself, with its own look and its
own second-long delay, and in the Electron shell it does not appear at all.
Two things about it depart from 1f, both forced by a real branch name:

- **It wraps, within a 300px cap.** 1f draws the line `nowrap`, which suits
  the names the artboard shows. An eighty-seven-character branch at `nowrap`
  makes a 592px bubble — wider than the panel it is explaining. It also has
  to say `whitespace-normal` explicitly, the row above it setting `nowrap`.
- **The hover target is the mark and the branch together**, not the branch
  alone. They are one reading, and it puts the bubble's left edge on the
  mark, which is where 1f aligns it.

**Nothing in the row may clip its overflow.** The bubble hangs below a 28px
row, so an `overflow: hidden` anywhere between it and the panel cuts away all
of it while the row goes on looking correct — which is how it first shipped.
The clip belongs on the path alone: the reading is `flex-none` and sized to
its own capped text, so it cannot outgrow its share. jsdom lays nothing out
and clips nothing, so this is guarded structurally, by asserting that no
ancestor of the bubble carries the clip.

**Live update.** The branch text fades out and in over 130 ms. No slide, no
width animation. The path start, the mark and the icons never move; a new
name changes only the branch's own right edge, and the path's cut point once
the row is full.

**Not a repo removes the suffix, it does not blank it** — no placeholder, no
em dash, no reserved gap. The row goes back to exactly the shipped one.

**Panel width.** 1f flags 360px as an assumption; it is correct —
`DETAIL_PANEL_MIN_PX` is 360 and the clamp's floor wins over its ceiling, so
the panel cannot be dragged narrower. The 10-character branch floor holds.

## Files

| file | change |
|---|---|
| `server/src/git/gitState.ts` | new — pure resolution and parsing, no watching |
| `server/src/git/store.ts` | new — cache, watches, root → cwd index |
| `server/src/api/shape.ts` | `GitLocation`, the `git` field, `ctx.git` |
| `server/src/index.ts` | construct the store, republish on `HEAD` change |
| `web/src/lib/types.ts` | mirror `GitLocation` on `ApiSession` |
| `web/src/lib/format.ts` | head and middle truncation, and the width split |
| `web/src/panels/DetailPanel.tsx` | render the suffix in row 1 |

## Tests

Worth testing, and matching the repository's rule (parsing and path handling
with edge cases, plus a server-side data path):

- `gitState`: main checkout, linked worktree via a `gitdir:` file, detached
  `HEAD`, a `cwd` nested several directories inside the repository, a `cwd`
  with no repository above it, a malformed `HEAD`, a default branch from
  `origin/HEAD`, from `packed-refs`, and from neither. Against temporary
  directories holding real `.git` shapes — no git process required, since
  nothing under test spawns one.
- `GitStore`: a cache hit does not re-read the disk; an invalidation causes
  a re-read; a removed `HEAD` drops the entry.
- The session shape carries `git` for a session in a repository and null for
  one outside.
- The width split: both fit; path cut to its floor; branch middle-cut to its
  floor; the 24-character cap applied when there is room to spare; the
  head cut snapping to a `/`.

Not tested: the indicator's appearance, spacing, ink or the 130 ms fade.
Canvas fidelity is verified against `Feature - Git worktree` during the work.
