---
id: the-editors-findings-go-where-a-file-is-already-open
title: The editor's findings go where a file is already open
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-23-ide-bridge-design
  - 2026-09-19-file-viewer-design
  - orbital-speaks-to-the-ide-itself
tags:
  - ide
  - file-viewer
---
# The editor's findings go where a file is already open

## The problem

`getDiagnostics` answers with what the editor's own inspections know: errors
and warnings from analysis no test run performs and no build reports. The
value is real and specific — it can answer "did that edit break anything"
without running anything.

But the tool is only half a feature. The other half is a surface, and the
question the spec left open is which one. The obvious readings each want
something Orbital does not have:

- **a session-level readout** ("3 errors in this workspace") would sit on the
  planet or in the detail panel's header. Neither has a slot for it, there is
  no artboard for one, and a count with nowhere to click is a number, not an
  answer;
- **beside the edit in the transcript** would need findings attached to a turn.
  Diagnostics are the editor's state *now*, not a fact about a turn — the same
  ambient standing git and the selection have — so pinning them to a row would
  be recording something that is not a record.

## What was decided

**The file viewer.** Diagnostics for the file it has open: a count in the
header's meta line beside the size and the language, and the affected gutter
numbers tinted, with the messages on the number's hover text.

Three things make it the honest home rather than an invented one:

1. It is the only surface in Orbital that renders a file's lines, and a
   diagnostic is a per-line fact about a file. The data and the surface already
   have the same shape.
2. It is where someone has already shown interest in one particular file —
   which is the same reason the spec put the "open in the editor" link in this
   header and not on every path row.
3. It closes the loop the bridge is for. A path in the transcript opens the
   file; the editor's opinion of that file is right there; ⌥-click the same
   path and you are in the editor at the line.

The readout follows the viewer's own posture: a snapshot taken when the file
opens, not a watch. The bytes do not reload either, so a readout that kept
refreshing would be describing a file the reader is no longer looking at.

A clean file says nothing rather than saying "0 errors" — the absence is the
answer, and a zero would be one more thing on a line that is already dense.

## What was ruled out

**Building a session-level surface for it.** That is the outcome the brief
explicitly allowed — say so and stop rather than invent one — and it is what
the *roll-up* gets: there is no workspace-wide diagnostics view, and none was
invented. What landed is the per-file answer, on a surface that already
existed. The server route (`GET /api/sessions/:id/ide/diagnostics`) takes an
optional `path` and answers for the whole workspace without it, so a roll-up
needs a surface and nothing else.

**A per-line rail or row wash.** The target line already owns the row's wash
and inset rail (canvas 8e). Two meanings on one surface is how both stop being
readable, so the findings mark the gutter *number* and leave the row alone.

## What follows from it

- The gutter marking borrows the panel's existing two hues — the amber
  `--color-warning` and the toast surface's red. Canvas 20f records "new
  colours: none" for this feature, and this obeys it.
- The left side of the comparison is Orbital's read of the file on disk, while
  the diagnostics are the editor's view of its own buffer. A file with unsaved
  changes in the editor can therefore report a line that reads oddly. It is
  visible rather than hidden, and no decision is made from it.
