---
id: an-arriving-diff-is-a-preview
title: A diff that arrives open is a preview, and a hand-toggled row keeps its choice
status: in-force
type: adr
domain: web
related:
  - 2026-09-23-edit-diffs-in-the-transcript
  - 2026-09-23-permission-and-plan-decisions-design
  - settings-sections-split-by-kind
tags:
  - transcript
  - settings
---
# A diff that arrives open is a preview, and a hand-toggled row keeps its choice

## The problem

Edits render as diffs in the transcript, and tool rows arrive collapsed. For
anyone reading along while an agent works, that is a click per edit — the
thing they most want to see is the thing behind the most clicks. So the
transcript gets a setting for how edit rows arrive.

Opening them by default is not free. A session that rewrites a large file
would arrive with hundreds of lines in the transcript, and the transcript is
also the thing being scrolled while more of it arrives. A setting that makes
Orbital unusable on the one session that needed it most is not a setting worth
having.

There is a second question underneath: what the setting means for a row the
reader has already touched.

## What was decided

**A row that arrives open shows a preview, not the change.** The first hunk,
capped at `DIFF_PREVIEW_LINES`, with a line saying how much is not shown.
Opening a row by hand is still what shows all of it. The cost of turning the
setting on is therefore bounded per row, and the bound does not depend on how
large the edit was.

**A row the reader has toggled keeps that choice, whatever the setting says.**
`ToolRow` holds `override: boolean | null`, where `null` means untouched and
is the only state the setting governs. The first click writes a boolean and
the row answers to that from then on.

**The setting lives in Appearance, not Sessions.** It changes what is drawn
and no session's fate, which is the line [[settings-sections-split-by-kind]]
draws. It gets its own `TRANSCRIPT` kicker rather than joining `MAP` or
`CONTEXT USAGE`, on that same ADR's reasoning that a kicker which misdescribes
its rows is what split the dialog in the first place.

**An edit awaiting permission is shown whole, and elsewhere.** A second
setting, default on, shows the diff of an edit its session is blocked on. It
is not read by `ToolRow` at all: a call the session is parked on is routed to
a `PermissionCard` by `groupToolRuns`, so the permission card is where it is
honoured, and there it renders the change in full rather than as a preview.
Being asked to approve a change is the one moment the whole of it has to be
readable.

## What follows from it

**The shipped default is `collapsed`,** so nothing about the transcript
changes for anyone who does not go looking. This is the opposite convention to
the map's switches, which are default-on and read as `!== 'false'`; here only
the exact word `expanded` opens anything, and an unreadable value leaves the
transcript as it was.

**The preview's cap is not the diff's cap.** `DIFF_MAX_RENDERED_LINES` still
bounds a hand-opened diff. The preview is a second, much tighter bound that
applies only to the arriving state, and the two notes they produce say
different things: the preview points at the row, the truncation points at the
file.

**A row with nothing to show never opens itself.** The setting is about edit
diffs, so a `Bash` call does not arrive with its input JSON unfolded — which
would be the literal reading of "expanded" and is not what anyone asked for.
