---
id: an-ide-selection-rides-as-a-quoted-block
title: An IDE selection rides with the prompt as a quoted block, read back for the caption
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-23-ide-bridge-design
  - orbital-speaks-to-the-ide-itself
  - 2026-09-20-composer-design
tags:
  - ide
  - composer
---
# An IDE selection rides with the prompt as a quoted block, read back for the caption

## The problem

The spec settles that the editor's selection attaches to every prompt while it
stands, and the canvas settles that the sent turn shows the typed words with the
range as a caption beneath them. Neither says **what the selection turns into on
the wire**, and there are only two places it could live: inside the prompt text,
or beside it.

Beside it is not available. `POST /api/sessions/:id/messages` carries text and
image refs, the runner hands the text to the SDK, and the SDK's transcript is
what Orbital reads back on the next load. Any field invented alongside the text
would exist for exactly one round trip and then be gone — the turn comes back
off the CLI's own transcript as plain text and nothing else.

## What was decided

**The selection is written into the prompt text as a headed, fenced block, and
read back out of that same text wherever the browser needs to know a turn
carried one.**

```
Selected in the editor — @web/CLAUDE.md lines 84–88:

```
…the selected text…
```

what does this do?
```

Three things follow from the shape:

- **The block comes first and the typed words last**, so the question is the
  last thing the model reads.
- **The fence is longer than the longest run of backticks in the selection**, so
  a selection that is itself fenced markdown cannot close the block early. This
  is also what makes the block unambiguous to read back: the head names the
  fence, and the first occurrence of that fence at a line start is the end.
- **The path is relative to the session's cwd and written with a leading `@`**,
  which is the vocabulary the composer already uses for a file and which the
  agent already reads as one.

`parseSentSelection` is the inverse, and it is what the transcript's caption is
drawn from: the bubble shows the typed words, the caption shows the count and a
pressable path to the lines. A turn that does not open with the head is not a
carrier, which is almost every turn.

**A selection longer than `IDE_SELECTION_MAX_CHARS` is cut, and says so.** ⌘A is
one keystroke away, and the selection re-attaches to *every* prompt while it
stands — so without a cap a large file would ride along with every message of a
conversation. The cut block still names the file and the range, which is what
lets the model read the rest for itself.

## What was ruled out

**A field on the message beside the text.** It would survive the optimistic turn
and the WS echo and then vanish on the next reload, leaving a caption that
appears and disappears depending on how the turn was loaded. A reader that
cannot answer consistently is worse than no reader.

**Attaching only `@path` with no text.** It is smaller, and it is what the
composer's own mention already does — but it makes the model re-read a file to
see something the person is looking at right now, and it loses the range
entirely once the file changes. The whole point of the bridge is that the
selection travels.

**Storing the selection on the session row.** Ruled out by
[[orbital-speaks-to-the-ide-itself]] before this question came up: nothing about
the editor is recorded, and a sent turn is a record.

## What follows from it

The block's wording is a parsing contract between `promptWithSelection` and
`parseSentSelection`, not prose to be edited freely. Changing the head or the
`lines A–B` spelling silently stops every already-sent turn from showing its
caption — the turns are in the CLI's transcript files and cannot be migrated.
Both functions live in `web/src/lib/ideSelection.ts`, and the round trip is
covered by `web/src/test/ideselection.test.ts`.
