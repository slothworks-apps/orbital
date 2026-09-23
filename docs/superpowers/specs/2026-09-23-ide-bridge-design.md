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

The store keeps only the latest and publishes at most once per
`IDE_SELECTION_PUBLISH_MS`, dropping a payload equal to the one before it.
Nothing about a selection is worth delivering promptly enough to justify
flooding the browser socket; the trailing edge is what matters, and it is what
gets sent.

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
  /** As the lock reports it: "WebStorm", "Visual Studio Code". */
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

## The chip and the prompt

When `selection.text` is non-null, the composer shows a chip naming the file and
the line count, in the CLI's own words: *Selected 5 lines from CLAUDE.md*. The
chip is dismissible, and dismissing it drops that selection until the next one
arrives.

**The selection attaches to the next message automatically.** Sending with a
live chip prepends the selected text, its path and its line range to the
message before the typed text, and clears the chip. This is the terminal's
behaviour and the point is not having to learn a different one.

The chip is not an `AttachmentChip`. Attachments upload to the server and carry
retry and refusal states (`useAttachments`); a selection is ambient state that
is already on the client and can vanish on its own. It reuses the visual
language and none of the machinery.

A caret-only selection — `text` is null — shows no chip and attaches nothing.
It still updates `filePath`, which is what the next section uses.

## Open files, for `@` completion

`GET /api/sessions/:id/ide/open-files` calls `get_all_opened_file_paths` on the
connection covering that session and returns absolute paths, or `404` when
there is no editor. The composer's `@` completion
(`server/src/files/complete.ts`) ranks open tabs above other matches, with the
file holding the caret first.

This is the whole justification for the pull direction: an editor's open tabs
are a far better guess at what you mean by `@Det` than an alphabetical walk of
the working tree.

## Talking back to the editor

The extension's tools make three more things possible. They are listed in the
order they should be built, because the third has a dependency the first two do
not.

**`openFile` — a path in Orbital opens in the editor.** Clicking a file in the
transcript, the file viewer or a tool row jumps WebStorm to that file and line.
Cheap, self-contained, and it makes Orbital a place you navigate *from*.

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
