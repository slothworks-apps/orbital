---
id: 2026-11-02-bare-file-names-and-path-menu-design
title: A bare file name in a code span is pressable, and every path has a context menu
type: spec
status: done
domain: web
related:
  - a-code-span-that-is-a-path-is-pressable
  - 2026-09-19-file-viewer-design
  - 2026-10-26-media-viewer-context-menu-design
  - 2026-10-24-session-context-menu-design
  - 2026-09-23-ide-bridge-design
  - a-file-link-resolves-against-the-cwd-it-was-written-in
tags:
  - transcript
  - detail-panel
  - ui
---

# A bare file name in a code span is pressable, and every path has a context menu

Two changes to the paths in the transcript.

1. **Bare names.** The assistant often names a file without its directory:
   `` `findAll.ts` ``. Today that stays inert text, because a path needs at
   least one `/` (`shared/src/paths.ts`, `PATH_RUN`). After this change an
   inline code span that is one bare file name and nothing else is pressable.
   What it opens is decided when it is pressed: the server looks the name up
   in the session's tree, one match opens, several open a chooser, none says
   so in the same popup.
2. **A context menu.** A right-click on any pressable path (prose, code span,
   tool row, INPUT value) opens a menu: Copy path, Copy relative path,
   Open in ‹IDE›, Show in Finder, Mention in reply. Today a right-click on a
   path does nothing (the desktop app has no native context menu).

The design is `Feature - Path menu glyphs.dc.html`: 1a in situ, 1b the menu,
1c the chooser, 1d right-click on an ambiguous name, 1e the pending press, 1f
the phone, 1g the glyphs. Where this spec and the canvas disagree on what is
drawn, the canvas wins; where they disagree on behaviour, ask.

## The bare name

### What counts

- Only an **inline code span** whose whole content, trimmed, is one bare
  name: no `/`, a basename with an extension `isPressablePath` accepts (text,
  image or PDF), optionally followed by `:line` or `:line:col`. Same span rule
  as the ADR `a-code-span-that-is-a-path-is-pressable`: `` `findAll.ts` `` and
  `` `findAll.ts:42` `` qualify, `` `cat findAll.ts` `` does not.
- **Not in prose.** A bare name in running text stays text, so `Node.js` or
  `Next.js` in a sentence is never underlined. In prose a path still needs a
  `/`, exactly as today.
- A user turn, a fenced block and a link are untouched, as today.
- The server's media list for a reply (`mediaPathsInReply`, the gallery and
  the reply's thumbnails) does **not** take bare names: it lists paths without
  resolving them, and a bare name means nothing until it is resolved. A bare
  image name is pressable and opens the media view once resolved, but draws no
  thumbnail. (Builder's call to confirm against the code; the point is that
  the gallery does not start guessing.)

Detection stays a pure function in `shared/src/paths.ts` (a code-span-only
finder beside `findPathMatches`), so the web, the phone and the server keep
agreeing on what is a path. The rehype plugin marks a bare-name link so the
press knows to resolve it first (for example `data-bare`).

### What a press does

A press on a bare name asks the server where the name lies, then:

| matches | what happens |
|---|---|
| 0 | the chooser opens with no rows and one fact, "no file by that name under ‹directory›" (1c NO MATCH); no error colour |
| 1 | opens it exactly as a press on its full path would (viewer, or media view for an image or PDF; `:line` carried) |
| 2 or more | a chooser opens at the link, one row per match, showing the path relative to the tree it was found in; picking a row opens that file as above |

The chooser is the existing popup (`MenuPopup`), drawn in 1c: a caption row
(`index.ts · 20 matches`), then one row per match with `FileGlyph`, the
folder dimmed and the name in full ink, and `touched` in the key column. `ContextMenu` today anchors only to a pointer point; the chooser
anchors to the link's rectangle, either through `MenuPopup` directly or by
letting `ContextMenu` take an element anchor (builder's call).
Rows the session itself touched (a path its transcript names) come first,
then the rest by path, shortest first. The list shows at most
six rows (1c); past them a last row says how many more there are
(`+14 more`). Picking it swaps the popup in place to every match, scrolling
six rows at a time (author's call, after review: 1c draws the row inert,
which left the other matches of an `index.ts` in a monorepo unreachable).
The server returns at most `FIND_LIST_MAX` (100) matches; past those an
inert note says how many more there are. The phone's sheet scrolls and
lists every returned match.

### While the lookup runs (1e)

- From the press, the link holds its pressed pill and nothing else: an answer
  faster than `FIND_PENDING_MS` (300 ms in 1e) looks like pressing any other
  link.
- Past it, a static `…` fades in after the chip over 200 ms; no pulse, no
  spinner, nothing around it moves.
- The answer clears both and replaces them (the viewer, or the chooser).
- No answer within `FIND_GIVE_UP_MS` (4 s in 1e): the chooser opens anyway
  with one fact, "‹device› didn't answer", and Try again. No error colour, no
  entry in the error log.
- A press elsewhere while it waits drops the lookup silently.

### The server: `GET /api/files/find`

`GET /api/files/find?session=…&name=…[&cwd=…]` answers
`{ matches: [{ path, relative, touched }], more: number }`, `path` absolute;
at most `FIND_LIST_MAX` matches, `more` counting the rest.

- `name` must be a bare name: no `/`, no `\`, not `.` or `..`, and it must
  pass the same extension check. Anything else is a 400.
- **Where it looks: inside the sandboxes, never past them** (author's call).
  The sandboxes are the ones every file route reads through,
  `sandboxesOf(row, cwd)` / `fileSandboxes`, and the search lists each
  sandbox directory and what lies under it, not its git tree root. Searching
  wider would find files the viewer then refuses as `outside_cwd`, and
  widening the reads is a change to the security boundary of every file route
  and the phone's reads, which this feature does not make. In practice a
  session runs at its repository's root, where the two are the same.
- **Which sandbox answers** (author's call): the first, in `fileSandboxes`'
  order, that has at least one match — the rule `readInSandboxes` applies to a
  read. A worktree session therefore lists the worktree's `index.ts` files,
  not the main checkout's copies of them too (adr
  `a-file-link-resolves-against-the-cwd-it-was-written-in`).
- **The user's home directory is never listed** (author's call): a sandbox
  that is `os.homedir()` itself is skipped by the search, so a session
  launched in `~` finds nothing by name and gives the not-found refusal. Any
  other directory, including the session's launch directory (the `home`
  argument of `fileSandboxes`, which is not `~`), is searched.
- **How it looks.** In a git tree, `git ls-files --cached --others
  --exclude-standard` run in the sandbox directory (tracked files and new
  untracked ones the agent may have just written, `.gitignore`d ones left
  out, which keeps `node_modules` and build output out). Outside git, a walk
  of the directory that skips the usual heavy directories (`node_modules`,
  `.git`, build output) and stops at a file-count cap. Matching is by exact
  basename.
- **Confinement.** Every match goes through `resolveForSession` against the
  sandbox it was found in, so a symlink out of it is dropped like any other
  path outside it.
- **Cost.** Nothing runs at render time. The lookup runs on a press, and its
  listing is cached per sandbox directory for a short time (a named
  constant), so a press, a pick and a right-click in a row list it once.
- **`touched`** (author's call): a match is touched when `namedBy` says the
  session's transcripts name its absolute path. Tool inputs (`Read`, `Edit`,
  `Write`) carry absolute `file_path`s, so this covers the files the session
  worked on; a file only ever written relatively in prose does not count,
  which keeps the route from scanning transcripts.
- `relative` is relative to the sandbox directory the match was found in.

**A Mac without the route.** In a device group the desktop forwards the
request to the session's member Mac, which may be older and refuse it
(author's call): a press that gets an unsupported or refused lookup falls
back to opening the name as written, which is today's behaviour for a path
relative to the session's directory, so a file at that directory's top still
opens and anything else gets the usual not-found refusal.

The route goes on the phone's allowlist (`server/src/remote/allowlist.ts`)
and into `control/catalog.ts` beside `read_file`.

## The context menu

A right-click on a `PathButton` opens `ContextMenu` at the pointer, on the
desktop only (the phone keeps its long-press, below). On a bare name with
several matches the menu first shows the chooser's rows; picking one swaps to
the actions for that file in the same popup (`ContextMenu`'s `view`, as the
session menu's Change tag does). The actions view starts with Back and a
caption naming the picked path (1d); ⌫ or ← goes back, as do the session
menu's keys otherwise. On a bare name with one match the actions show
straight away; with none, the chooser's "no file" fact.

The rows fall in three groups (1b): the two copy rows; the editor rows and
Show in Finder; Mention in reply. A separator stands only between two groups
that both have rows, so the browser with no editor has three rows and one
hairline. The rows carry no keyboard shortcuts (author's call, against 1b,
which drew some: a shortcut has no path to act on outside the open menu, and
⌥ combinations do not survive a Czech layout).

| row | shown when | does |
|---|---|---|
| Copy path | always | the absolute path, found by `GET /api/files/locate` (bare name: by the lookup); the path as written when neither finds it |
| Copy relative path | the file was located | the path relative to the root of its git tree, or to the session's working directory outside git |
| Open in ‹IDE› | one row per editor that has the file's workspace open (the rule `PathButton` already uses for ⌥-click, applied to each editor) | sends the file to that editor, with ⌥-click's receipt; the row names the editor (`Open in WebStorm`, `Open in VS Code`) |
| Show in Finder | the page runs in the desktop app (`canShowInFolder`) and the session runs on this Mac | `showInFolder` with the absolute path |
| Mention in reply | the session has a composer here (an Orbital session the user can write to) | inserts `@<path>` (with `:line` when the link carried one) at the composer's caret and focuses it, the same mention token the composer already tints; the path is relative to the session's working directory, which is what the CLI and the composer's own completion (`files/complete`) resolve a mention against, and absolute when the file lies outside it (author's call) |

Copy rows take `CopyGlyph`, Show in Finder `FolderGlyph`, as in the media
viewer's menu, the editor rows the new `EditorGlyph` (one for every editor)
and Mention in reply the new `MentionGlyph` (both drawn in 1g); Back takes the
session menu's `‹`; failures are recorded and said as there (adr
`errors-are-recorded-not-announced`). The row order is the table's.

### Every editor, not just the last used

WebStorm (the Claude Code JetBrains plugin) and VS Code (the Claude Code
extension) are both supported by the IDE bridge today. When both have the
session's project open, a workspace root has one editor behind it at a time,
the one used last (spec 2026-09-23-ide-bridge-design § Two editors on one
project), and the session reports only that one as `ide`. ⌥-click keeps
that rule. The menu offers a row for each:

- The session also reports **every** editor connected with its workspace
  open, as a new list beside `ide` (each with its name and an id the bridge
  can address it by). `ide` keeps its meaning, so an older client and the
  phone see no change.
- `POST /api/sessions/:id/ide/open-file` takes an optional editor id; with
  it the file goes to that editor, without it to the last-used one as today.
  Opening in an editor through the menu counts as using it, so it becomes
  the one ⌥-click goes to (the bridge's existing rule for an editor that
  publishes a selection; author's call).
- The menu's rows follow the editor order of the list, last used first.

Mention in reply needs a way to put text into the composer from outside it;
the composer has none today. A small store action (the composer reads it and
inserts at its caret) is the expected shape.

## Scope

- **Who it is for:** anyone reading a transcript where the agent names files
  by their name alone, and anyone who wants a path out of the transcript
  (into a terminal, another chat, the next message) without selecting text.
- **Where it lives:** on by default. Both add behaviour where there was
  none: a bare name in a code span was inert, and a right-click on a path did
  nothing. Nothing that worked before changes.
- **What someone already using Orbital notices:** names in code chips are
  underlined and open; a right-click on a path opens a menu.
- **What can be set:** nothing.

## The phone

Built for the phone too, the bare names; the menu stays desktop-only.

- The phone renders the same `MessageView`, so a bare name in a code span is
  pressable there as well. The phone's press goes through its `FileOpen`
  handler; for a bare name it calls `GET /api/files/find` over the relay
  first, then opens the one match, or shows the matches in the 10i bottom
  sheet (1f): same handle, mono title, 52 px rows; a tap on a row opens the
  phone's text preview, a tap on the scrim only closes it. The sheet picks a
  file and offers no actions. The pending press follows 1e.
- The phone updates before the Mac, so the lookup is gated in `MAC_FEATURES`
  (`findByName`, the desktop version that ships the route). Against an older
  Mac a bare name stays plain text on the phone (it is drawn as it would have
  been before), never a link that fails.
- The long-press on a path keeps copying it; on a bare name it copies the name
  as written. No context menu: the phone has no right-click, and its
  long-press is already the gesture for "do something else with this path".

## What was ruled out

- **Checking at render time that the name exists**, or keeping a file index
  per tree on the web. It would cost a listing per message rendered and memory
  per repository, and an old transcript would silently lose links as files
  move. A press is rare; resolving there costs nothing while reading. The ADR
  `a-code-span-that-is-a-path-is-pressable` made the same bargain for full
  paths.
- **Bare names in prose.** `Node.js`, `Next.js`, `Vue.js` carry a whitelisted
  extension and would be underlined in every sentence about them. The
  assistant writes file names in code spans almost always, so the span rule
  catches the case that matters.
- **Picking one match on the client's own guess** (say, the file the session
  last touched) without showing the others. Two `index.ts` are common; a
  wrong file opened silently is worse than a choice of two.
- **Open with the default app** in the menu. For a script or a `.command` it
  can run the file; Show in Finder reveals and never opens.

## Documents this changes

- The ADR `a-code-span-that-is-a-path-is-pressable` gains the bare-name case
  and the reason it is limited to code spans.
- `shared/src/paths.ts`'s header comment, which says a path has at least one
  `/`.
