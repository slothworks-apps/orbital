---
id: 2026-09-23-ide-bridge-design
title: The IDE bridge
status: draft
type: spec
domain: sessions
related:
  - orbital-speaks-to-the-ide-itself
  - git-location-is-ambient-not-recorded
  - feature-parity-with-the-claude-code-cli
  - 2026-09-20-composer-design
  - 2026-09-19-file-viewer-design
  - tilde-expands-at-the-api-boundary
tags:
  - ide
  - composer
  - mcp
---
# The IDE bridge

Orbital reads the editor the same way it reads git: as live state of a
directory that happens to be there, never as a record of a session. When
WebStorm is open on a workspace, every Orbital session working inside that
workspace can see what is selected in it, and the selection rides along with
the next message the way it does in the terminal. When no editor is running,
nothing about Orbital changes.

The decision to connect directly, and what it costs, is
[[orbital-speaks-to-the-ide-itself]]. This document is what gets built.

## The protocol, in four facts

1. The extension writes `~/.claude/ide/<port>.lock`. **The port is the file
   name**; the JSON inside carries `workspaceFolders`, `pid`, `ideName`,
   `transport` and `authToken`.
2. The token goes in an `X-Claude-Code-Ide-Authorization` header.
3. The WebSocket must request the `mcp` subprotocol. Omitting it fails the
   upgrade with `400` before anything else is looked at.
4. What follows is ordinary MCP: `initialize`, `notifications/initialized`,
   then `tools/list`.

The extension pushes `selection_changed` and answers tool calls. Its
notification looks like this:

```json
{"selection": {"start": {"line": 84, "character": 0},
               "end":   {"line": 88, "character": 39}},
 "text": "`display: inline` ignores width and height…",
 "filePath": "/Users/tomin/Projects/slothworks/orbital/web/CLAUDE.md"}
```

`text` is absent when nothing is selected and the caret merely moved. Lines and
characters are zero-based. Paths are absolute.

## Where it lives: `IdeStore`

`server/src/ide/store.ts`, shaped after `GitStore` and for the same reason —
the thing being tracked belongs to a directory, and several sessions share it.

- A `chokidar` watch on `~/.claude/ide` picks up locks as they appear and
  vanish. A lock that cannot be parsed is ignored, not retried.
- Each lock becomes one connection, keyed by **workspace root**: every entry of
  its `workspaceFolders`. One editor process can hold several locks — one per
  open project — and they are separate connections with separate tokens.
- `locate(cwd)` answers which connection covers a `cwd`, by longest matching
  workspace root, or null. Resolutions are cached both ways, like `GitStore`'s
  `rootByCwd` / `cwdsByRoot`, so a change can name the sessions it touches.
- The store emits `change` with the workspace root and the affected `cwd`s.
  `index.ts` turns that into republished sessions, exactly as it already does
  for a `HEAD` that moved.
- A stale lock — the port refuses the connection — is left on disk. Deleting
  other processes' lock files is the CLI's job, not Orbital's.

`ShapeContext` gains an `ide: IdeStore` field alongside `git`.

## Normalising a selection

The raw notification is not what anyone wants to look at. One pure function
turns it into the shape the rest of the system uses, and it is the piece worth
testing:

```ts
interface IdeSelection {
  filePath: string;
  /** 1-based, so it matches what the editor's gutter shows. */
  lineStart: number;
  lineCount: number;
  /** null when the caret moved and nothing is selected. */
  text: string | null;
}
```

`lineStart` is `start.line + 1`. `lineCount` is `end.line - start.line + 1`,
**decremented when `end.character` is zero** — a selection dragged to the start
of the next line does not include that line, and without this correction every
full-line selection reads one line too long. This mirrors the CLI's arithmetic
so that Orbital and the terminal describe the same selection identically.

Edge cases the tests should pin: a caret with `start === end`; a selection
ending at column zero; a single-line selection; a selection spanning the end of
the file.

## Debouncing

The editor fires on every tick of a drag. One ordinary selection of five lines
produced **92 notifications inside a single second**, several of them byte-for-byte
identical.

The store keeps only the latest and drops a payload equal to the one before it.
Nothing about a selection is worth delivering promptly enough to justify
flooding the browser socket; the trailing edge is what matters, and it is what
gets sent. The two rates the canvas asks for — the cursor line's throttle and
the lip's debounce — are applied in the browser, on one publish stream, rather
than by publishing twice.

## What reaches the browser

`ApiSession` gains one nullable field, next to `git`:

```ts
/**
 * The editor open on this session's workspace right now, or null when none is
 * — the live state of a directory rather than a fact about the session
 * (adr `orbital-speaks-to-the-ide-itself`).
 */
ide: IdeContext | null;

interface IdeContext {
  /**
   * As the lock reports it. Measured: the JetBrains extension names the
   * product, not the vendor — this machine's lock says `WebStorm`, so the
   * slot can say it too rather than falling back to a family name.
   */
  ideName: string;
  workspaceRoot: string;
  selection: IdeSelection | null;
}
```

Open files deliberately do **not** ride on the session shape. There can be
dozens of them, they change constantly, and only one surface wants them — so
they are fetched on demand instead (below).

Two sessions in the same workspace always show the same selection, for the same
reason two sessions in one checkout always show the same branch.

## The slot and the lip

Canvas `Feature - IDE bridge.dc.html`, artboards 20a/20b, with placement C of
20e as the build. The design supersedes the "chip" this spec first proposed,
and the distinction it draws is the right one:

- **a chip is something you put there** — an attachment you chose, which
  uploads and can fail;
- **a lip is something the world put there** — ambient state that arrives and
  leaves on its own.

So the editor gets its own **slot on the composer well's edge**, not a chip in
the well. It slides up from behind the edge when an editor connects and back
down when one goes, as an overlay — nothing reflows.

- **Cursor only** (`text` is null): a read-out line, no border, no ×. It names
  the file and line and attaches nothing.
- **Selection**: a lip rises out of the well over the cursor line, carrying the
  count and the file, with a × that drops it.
- **No editor, or an editor on another project**: nothing. The panel is
  shipped 1b exactly.

A lip and an attachment chip never share a row — the chip stays in the well,
the lip sits on its edge.

### Behaviour

The canvas describes how the slot looks and moves. What follows is what it
does, which is decided here.

**The selection attaches to every prompt while it stands, as the CLI does.**
This was settled when the feature was agreed: the terminal's behaviour, so
there is nothing new to learn. The canvas proposes the alternative — send it
once, then wait for a change — and the argument for it is real, that
re-attaching an unchanged selection is noise. It is not taken, for two reasons.
The first is the agreement. The second is that the protocol cannot support it
cleanly: a selection can be keyed by **file + range + text**, but there is **no
editor revision** in the payload, so an edit that leaves the same range
selected with the same text is indistinguishable from no change — and
send-once would silently skip it. Re-attaching is never wrong in that way.

**Dismissal is per session.** The selection belongs to the workspace and every
session in it sees the same one, but × is a statement about *this*
conversation — that the selection is not relevant to what is being asked here.
Clearing it for the other sessions would make one panel's housekeeping reach
into another's. Dismissed selection ids are therefore kept per session, and the
lip sinks back to the cursor line until the selection changes.

**Two rates, because there are two problems.** The cursor line rewrites in
place at `IDE_CURSOR_THROTTLE_HZ` so that arrowing through a file does not
strobe; the lip waits `IDE_SELECTION_DEBOUNCE_MS` after the first change so a
drag-select does not flash "1 line" before settling. One interval cannot serve
both: the cursor wants to keep up, the lip wants to wait. The canvas's motion
timings are a good starting point for the values and nothing more.

## Open files, for `@` completion

`GET /api/sessions/:id/ide/open-files` calls `get_all_opened_file_paths` on the
connection covering that session and returns absolute paths, or `404` when
there is no editor. The composer's `@` completion
(`server/src/files/complete.ts`) ranks them above other matches. Canvas
artboard 20c: no section header, no divider, no second list — open tabs are
just ranked higher, and "open" is said in the row's existing mark slot.

This is the whole justification for the pull direction: an editor's open tabs
are a far better guess at what you mean by `@Det` than an alphabetical walk of
the working tree.

**Ranking by recency is not possible, so the order is the editor's own.**
Measured on 2026-09-23: two calls to `get_all_opened_file_paths` an hour apart,
across several tab switches in between, returned byte-identical order, with
files just visited still sitting in their original positions. The list is
stable — the order tabs sit in, not the order they were used in.

That is a good enough answer, and better than sorting alphabetically: it is the
order the person can see in their own tab bar, so the list matches what they
are looking at. The ranking is:

1. the active tab, if it matches the prefix — known from `selection_changed`'s
   `filePath`, which arrives on a bare cursor move and needs no selection;
2. other open tabs, **in the order the extension lists them**;
3. `9b` as shipped: directories, then files, alphabetical.

Tabs outside the session's `cwd` are not listed; the sandbox rule wins.

## Talking back to the editor

The extension's tools make three more things possible. They are listed in the
order they should be built, because the third has a dependency the first two do
not.

**`openFile` — a path in Orbital opens in the editor.** A file path in the
transcript already opens the file viewer, and that stays the primary meaning;
opening in the editor is the secondary one, so it hangs off a held modifier
rather than competing for the same click or adding a control to every row. The
file viewer's header carries the one worded link that teaches the gesture,
because that is where someone has already shown interest in a particular file.
Canvas artboard 20d draws all of this — the hover treatment, the destination
suffix, the receipt after the click.

**`getDiagnostics` — the editor's own errors.** The editor already knows what is
broken, from inspections no test run reports. Surfaced on the session, this
answers "did that edit break anything" without a build.

**`openDiff` — the editor becomes the approval surface for edits.** The tool
takes `{old_file_path, new_file_path, new_file_contents, tab_name}` and does not
return until the human acts, answering with content whose first element is
`FILE_SAVED` (accepted, and element two carries the possibly hand-edited
result), `DIFF_REJECTED`, or `TAB_CLOSED`. `close_tab` cleans up.

That is an approval flow already built, and Orbital would only have to route to
it. **But it presumes Orbital has somewhere to ask permission from, and today it
does not**: `canUseTool` parks `AskUserQuestion` and denies every other tool
outright (`server/src/runner/runner.ts`, and
[[feature-parity-with-the-claude-code-cli]]). `openDiff` is not a way around
that gap — it is a surface to hang on the permission flow once that flow exists,
and it must not be built before it. When it is built, the IDE is one route among
others and never the only one; an edit must stay approvable with no editor
running.

`reformat_file` and `close_tab` are available and nothing currently wants them.

## When there is no editor

Every one of these is ordinary, and each resolves to the behaviour Orbital has
today:

- no lock files — `ide` is null on every session, no chip, `404` from the
  open-files route;
- a lock whose port refuses the connection — same, and the lock is left alone;
- the editor quits mid-session — the socket closes, the entry is dropped, the
  affected sessions republish with `ide: null`, the chip disappears;
- the editor is open on a *different* project than the session's `cwd` — no
  match, so null, which is correct rather than a failure;
- a tool the connected extension does not list — the feature depending on it is
  absent for that editor, and nothing else is.

A session never fails, stalls or refuses to start because of anything in this
document.

## Testing

Worth testing, per the repository's rule:

- the selection normaliser, value by value, including the column-zero
  correction;
- `locate(cwd)` — longest-root matching, nested workspaces, no match, the
  reverse index that names affected `cwd`s;
- lock parsing: port from the file name, a malformed lock ignored, a lock
  appearing and disappearing under the watch;
- the debounce: many inputs in, one output, identical payloads suppressed;
- the open-files route: `404` without an editor, paths with one.

Not worth testing: that the chip renders its props, and anything that would
require a live editor to assert against.

## Out of scope

- Changing what the editor does. Orbital never installs the extension, launches
  an editor, or writes a lock file.
- Any record of the selection. Nothing is stored, no column is added, and an
  ended session shows the editor's today exactly as it shows the directory's
  branch today.
- `at_mentioned`, the extension's push of a file into the conversation. It is a
  keystroke in the editor aimed at a terminal that is listening; what it should
  mean when several Orbital sessions are open is a question this spec does not
  answer.
- VS Code. The bridge is built to discover tools rather than assume them, but it
  is measured against JetBrains only, and the VS Code tool set is unverified.
