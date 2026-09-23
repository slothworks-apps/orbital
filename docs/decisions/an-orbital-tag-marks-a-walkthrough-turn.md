---
id: an-orbital-tag-marks-a-walkthrough-turn
title: An Orbital tag in the message text marks a walkthrough turn
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-23-walkthrough-design
  - walkthrough-narration-is-a-turn-in-the-session
  - ephemeral-title-queries
  - 2026-09-18-transcript-folding-design
tags:
  - walkthrough
  - transcript
  - parser
---
# An Orbital tag in the message text marks a walkthrough turn

## The problem

The walkthrough sends turns into a session — a request to narrate, a question
about a step — and later has to find them again in the transcript: to read
the narration back, to attach a question and its answer to the step it was
about, and to fold the machinery behind a chip so the transcript reads
cleanly. Orbital does not learn the uuid of a user message it sends; the CLI
mints it when it writes the entry. So the turn has to be recognisable from
its content.

[[ephemeral-title-queries]] ruled out recognising a turn by its wording: the
prompt text doubling as a wire format breaks on the first rewording and can
swallow a real turn that happens to start the same way.

## What was decided

**Orbital writes an explicit tag into the text of the turns it sends**, and
that tag is the wire format:

```
<orbital-walkthrough kind="narrate">…</orbital-walkthrough>
<orbital-walkthrough kind="ask" step="<uuid>" n="3">…</orbital-walkthrough>
```

- The tag is Orbital's own, namespaced by name, so a human is not going to
  type it and the CLI is not going to emit it.
- The attributes carry the only structure Orbital needs back: the kind of
  turn and, for a question, the id of the step it was about. `n` is the
  step's ordinal when asked, for the chip's label only.
- The parser already treats a fixed set of tags as machinery
  (`NOISE_BLOCK`), splitting them off the human text and folding them behind
  a chip in both transcript producers. The tag joins that set, so the
  transcript handles it with code that exists.

This is not what the title ADR ruled out. That was *inferring* intent from
prose; this is a marker put there to be found, the same way `<command-name>`
is.

## What was ruled out

- **A table mapping message ids to walkthrough turns.** Orbital does not have
  the id when it sends, so the row would have to be written after the fact by
  matching the transcript's next user entry — a race with the watcher, and a
  second store for a fact the transcript already holds.
- **Recognising the turn by its prompt text.** Ruled out once already, for
  reasons that still hold.
- **A separate session or query for the walkthrough's turns.** Decided against
  in [[walkthrough-narration-is-a-turn-in-the-session]].

## What follows

- The tag name and attribute names are a contract between the sender
  (`server/src/walkthrough`) and the parser. Both live in the server, so a
  rename is one change, but transcripts already on disk carry the old name
  forever — the parser accepts what it has ever written.
- The block folds like a command expansion: `walkthrough · narrate`,
  `walkthrough · ask`. Nothing typed by a human is inside it, so the chip is
  the whole turn for a narration and the question stands alone as text for
  an ask.
- The model sees the tag too. The block is written so that it reads as an
  instruction with context, and the tag's presence in the prompt is part of
  what the model is asked to answer.
