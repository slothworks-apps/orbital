---
id: 2026-09-23-ide-bridge-design
title: The IDE bridge
status: active
type: spec
domain: sessions
related:
  - orbital-speaks-to-the-ide-itself
  - git-location-is-ambient-not-recorded
  - feature-parity-with-the-claude-code-cli
  - 2026-09-20-composer-design
  - 2026-09-19-file-viewer-design
  - 2026-09-23-permission-and-plan-decisions-design
  - the-editor-is-a-second-route-to-one-verdict
  - a-hand-edited-diff-comes-back-as-the-tools-own-input
  - the-editors-findings-go-where-a-file-is-already-open
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
- Each lock becomes one connection, held **by port** — the lock file is the
  unit, and one editor process can hold several, one per open project, with
  separate tokens. A connection *claims* the workspace roots in its
  `workspaceFolders`, but only once its handshake and `tools/list` have come
  back: until then it is invisible, which is how a stale lock on a refusing
  port stays "no editor" rather than becoming a broken one.
- A lock rewritten with the same contents is left alone. A lock rewritten with
  a new token or new folders is a new editor session on that port, so the old
  socket is dropped and a new one opened.
- `locate(cwd)` answers which connection covers a `cwd`, by longest matching
  workspace root, or null. Resolutions are cached both ways, like `GitStore`'s
  `rootByCwd` / `cwdsByRoot`, so a change can name the sessions it touches.
- Unlike a working tree, an editor comes and goes under a running session, so
  a cached resolution is not final: every `cwd` the store has ever been asked
  about is re-answered whenever the set of connected workspaces changes, and
  the ones that moved are what `change` carries.
- The store emits `change` with the workspace root and the affected `cwd`s.
  `index.ts` turns that into republished sessions, exactly as it already does
  for a `HEAD` that moved — one helper now serves both.
- A stale lock — the port refuses the connection — is left on disk. Deleting
  other processes' lock files is the CLI's job, not Orbital's.
- A lock naming a `transport` other than `ws` is ignored rather than tried:
  the only client here speaks WebSocket. A lock that omits the field is taken
  at the word of everything else in it.

`ShapeContext` gains an `ide: IdeStore` field alongside `git`, and the store is
`start()`ed rather than used straight from its constructor — starting is what
reads the lock directory and opens sockets, and none of that may sit in front
of a session.

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
**decremented when `end.character` is zero and the range spans more than one
line** — a selection dragged to the start of the next line does not include
that line, and without this correction every full-line selection reads one line
too long. This mirrors the CLI's arithmetic so that Orbital and the terminal
describe the same selection identically.

The "spans more than one line" guard is a correction to this spec as first
written, found while building: a caret is `start === end`, and a caret resting
in column zero is by far the commonest payload the extension sends. The
unguarded rule reports **zero lines** for it, which is not a reading anything
downstream can draw.

An empty `text` is treated exactly as an absent one — both mean the caret
moved and nothing is selected — so no lip is ever raised over an empty string.

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

`IDE_SELECTION_COALESCE_MS` is the window. It starts on the first notification
of a burst and is **not** extended by the rest of it: a drag that never lets go
still publishes, and what it publishes is wherever the drag had reached. A
payload equal to the last one published is dropped at the end of the window, so
the byte-identical repeats — a good third of the flood — never become a
republish of every session in the workspace.

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
connection covering that session and answers `{ files: string[] }` — absolute
paths, in the editor's order, filtered to the session's `cwd`.

`404` is the single answer to every kind of "no": an id that names no session,
no lock at all, a lock covering another project, a connection that never came
up, and an extension whose `tools/list` did not include the tool. One thing for
the caller to handle, and it is the thing Orbital did before this feature
existed.

The composer's `@` completion
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

The extension's tools make three more things possible. All three are built, in
the order given here, because the third had a dependency the first two did not
— a permission flow to hang on, which
[[2026-09-23-permission-and-plan-decisions-design]] since supplied.

Everything here obeys the same rule as everything above it: a missing editor, a
missing tool or a dropped socket costs the feature and nothing else.

### `openFile` — a path in Orbital opens in the editor

A file path in the transcript already opens the file viewer, and that stays the
primary meaning; opening in the editor is the secondary one, so it hangs off a
held modifier rather than competing for the same click or adding a control to
every row. The file viewer's header carries the one worded link that teaches
the gesture, because that is where someone has already shown interest in a
particular file.

Canvas artboard 20d draws it, and the build follows it:

- **rest** is exactly 8e. Nothing is added;
- **⌥ + hover** *drops* the hover fill — it is not the viewer any more — and
  leaves the solid accent underline over bright ink, with the destination
  written after it (`↗ WebStorm`, mono 10 at `.55`, 8px out);
- **after ⌥-click** the span reads at rest again and the suffix becomes
  `opened in WebStorm` for 1.6s. The pointer is usually still on the path, so
  the hover emphasis is suppressed rather than merely not applied;
- ⌥ **does nothing and shows nothing** unless the path is inside the editor's
  workspace. A relative path is one the session wrote about its own `cwd`, so
  only an absolute one is checked;
- the line travels: `:88` is part of the hit area and is passed on.

Why ⌥ and not ⌘ is 20d's own reasoning: ⌘-click already means "new window" to
hands trained by browsers, and ⌥ is JetBrains' own alternate key.

The header link is a text link with the shortcut beside it — "the same shape as
the rest of that header, no button" — and the shortcut is what teaches the
gesture. **⌥⏎ is wired**, so the advertised key works wherever focus sits
inside the viewer.

`POST /api/sessions/:id/ide/open-file` takes `{path, line?}` and answers `204`.
A path outside the session's `cwd` is refused: Orbital will not *read* one for
a session, so it does not ask an editor to open one on that session's behalf.
Every kind of "no editor" is the same `404` the open-files route uses.

### `getDiagnostics` — the editor's own errors

`GET /api/sessions/:id/ide/diagnostics`, optionally `?path=`, answering
`{diagnostics: IdeDiagnostic[]}` filtered to the session's `cwd`. The tool
answers with JSON: `{uri, diagnostics}` groups holding LSP-shaped ranges and a
severity that arrives as a word on one build and a number on another. Lines are
zero-based on the wire and 1-based here, like a selection's.

It is surfaced **in the file viewer** — a count in the header's meta line and
the affected gutter numbers tinted, with the messages on their hover text.
Which surface it belongs on was the open question, and the answer is
[[the-editors-findings-go-where-a-file-is-already-open]]: the viewer is the only
place Orbital renders a file's lines, and a diagnostic is a per-line fact about
a file.

The **workspace-wide roll-up is deliberately not built**. It would need a
session-level surface that does not exist and has no artboard; the route already
answers for the whole workspace, so that half needs a surface and nothing else.

### `openDiff` — the editor as a second route to a verdict

`openDiff({old_file_path, new_file_path, new_file_contents, tab_name})` blocks
until the human acts and answers with a content array whose first element is
`FILE_SAVED` (accepted — element two carries the possibly hand-edited result),
`DIFF_REJECTED`, or `TAB_CLOSED`. `close_tab({tab_name})` cleans up.

**The browser card owns the decision; the editor is shown the same one.**
`Runner.decide()` parks, publishes and sets `needs_input` first, and only then
offers the review. Whichever answers first wins, `settleDecision` stays the
single settle, and it now also aborts the review — which drops the tab. The
whole routing argument, the id guard that makes two routes safe, and the four
failure modes are [[the-editor-is-a-second-route-to-one-verdict]].

`TAB_CLOSED` is **not** a verdict. It says "not here", so it resolves to no
answer and the decision stays parked — the same value an editor that quit
produces, and the same one an abandoned review produces.

Offered only for `permission` asks on `Write`, `Edit` and `MultiEdit`: the
three tools whose input both determines the resulting file and can be rewritten
to produce any other one. That second property is what lets a hand-edit in the
diff tab come back as the tool's own input rather than being discarded — see
[[a-hand-edited-diff-comes-back-as-the-tools-own-input]]. `close_tab` is
required alongside `openDiff`, because an abandoned review that cannot drop its
tab is worse than no review at all.

`reformat_file` is available and nothing wants it.

### Still to verify against a live editor

Whether the extension writes the file itself when the human saves a diff tab.
Both answers are safe — if it did, the rewritten input no longer matches and
the tool errors with the file already correct; if it did not, the tool writes
it — so the file ends up right either way, but the measurement is worth taking.

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

For *Talking back to the editor*, the state machine rather than the pixels:

- **the settle-exactly-once property, under every failure mode there is** —
  the browser answering while a diff is open, the editor quitting mid-diff, a
  tab closed without a decision, the request aborting, the session ending, a
  review that never answers, and a review that throws. Each must leave exactly
  one verdict and no orphaned tab. The sharpest of them is a late verdict
  naming a decision that is no longer the parked one, which must settle
  nothing at all;
- the edit arithmetic both ways, including a patch that does not apply and a
  hand-edit that round-trips back to the bytes the human saved;
- `parseDiagnostics` — both severity spellings, the line correction, and every
  malformed shape answering with nothing rather than throwing;
- `readDiffOutcome` — the three markers, the second element kept separate from
  the first, and an unrecognised marker reading as no verdict rather than a
  guess;
- the sandbox refusals on `openFile` and `diagnostics`, and that an abandoned
  `openDiff` still drops its tab;
- the two routes: `404` for every kind of no editor, `400` for a path-less
  open request.

Not worth testing: that the chip renders its props, the gesture's styling
values, and anything that would require a live editor to assert against.

## What is built

The server half, as of 2026-09-23:

- `server/src/ide/protocol.ts` — lock parsing, the selection normaliser, the
  workspace and sandbox matching, and the wire constants. All pure.
- `server/src/ide/client.ts` — `IdeSocket`, the WebSocket MCP client, behind an
  `IdeConnection` interface so the store can be tested without an editor. `ws`
  is now a server dependency, as the adr said it would have to be.
- `server/src/ide/store.ts` — `IdeStore`: the lock watch, the connections, the
  coalescer, `locate`, `cwdsFor` and `openFiles`.
- `ide` on `ShapeContext` and on `ApiSession`, beside `git`, and
  `GET /api/sessions/:id/ide/open-files`.

Measured working against the live WebStorm on this machine, through the source
and through an `esbuild` bundle of it — the DMG ships the bundle, and `ws`
carries optional native dependencies that a bundler has to get past.

The three outbound tools, and the browser half they needed, as of 2026-09-23:

- `protocol.ts` also holds the outbound tool names, `parseDiagnostics`,
  `pathFromFileUri` and `readDiffOutcome`. Still all pure.
- `client.ts` gains `callToolContent`, which answers with the result's raw
  content blocks rather than their text joined — `openDiff`'s verdict is the
  first block and the human's file is the second, a distinction joining
  destroys. `request()` now takes a per-call deadline (`NO_TIMEOUT` for
  `openDiff` alone) and an `AbortSignal`; an abandoned request sends
  `notifications/cancelled` and answers null.
- `server/src/ide/edits.ts` — the arithmetic both directions of a diff need:
  which tools are diffable, the file a tool would produce, and the input that
  reproduces a hand-edited one. Pure, and the piece most worth its tests.
- `server/src/ide/approvals.ts` — `IdeApprovals`, the narrow interface the
  Runner asks through, and its live implementation over the store. An
  interface so the Runner's tests can race both routes without an editor.
- `store.ts` gains `supports`, `openFile`, `diagnostics`, `openDiff` and
  `closeTab`.
- `runner.ts`: `decide()` offers the review after parking; `settleDecision`
  aborts it; `answerFromEditor` is the second route in, with the id guard that
  keeps two routes from ever settling one decision wrongly.
- `POST /api/sessions/:id/ide/open-file` and
  `GET /api/sessions/:id/ide/diagnostics`.
- Browser: `ide` on `ApiSession`, `api.ideOpenFile` / `api.ideDiagnostics`,
  the store's `openInIde`, the ⌥ gesture on `PathButton` (canvas 20d), and the
  file viewer's header link, ⌥⏎ shortcut and diagnostics readout.

Still to build: the composer's slot and lip with the per-session dismissal
(20a/20b/20e), and the `@` completion's ranking in
`server/src/files/complete.ts`. Nothing above assumes either.

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
