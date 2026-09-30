---
id: walkthrough-narration-is-a-turn-in-the-session
title: The walkthrough's narration is a turn in the session, not an ephemeral query
status: superseded
type: adr
domain: sessions
related:
  - 2026-09-23-walkthrough-design
  - walk-me-through-what-the-agent-did
  - ephemeral-title-queries
  - an-orbital-tag-marks-a-walkthrough-turn
  - narration-is-written-by-a-separate-reader
tags:
  - walkthrough
  - runner
---
# The walkthrough's narration is a turn in the session, not an ephemeral query

Superseded 2026-09-30 by [[narration-is-written-by-a-separate-reader]]: a
refused narrate turn locked the session out of every later turn.

## The problem

The walkthrough's spine is mechanical: steps are the runs that wrote files,
attribution is which call wrote which line. What it cannot do is group steps
into intents, say what was weighed and not done, or name an attempt as
abandoned when the code does not show it. That is a model's job, and the
question was which model call does it.

Two ways were on the table:

- **An ephemeral query**, the way the titler works ([[ephemeral-title-queries]]):
  spawn a one-shot `claude` with `persistSession: false`, hand it the
  transcript, get a structured answer, and leave no trace.
- **A turn in the session itself**: send the session one more user message
  asking it to narrate what it did, and read the answer back out of its own
  transcript.

## What was decided

**The session is asked.** Decided 2026-09-23 with the owner, together with
the decision that a question about a step also goes to the session.

- The model that did the work explains it from the context it actually had,
  not from a transcript it is reading cold. What it considered and rejected is
  in that context and nowhere else.
- The session's context is cached. An ephemeral query pays for the whole
  transcript again, uncached; on a long session that is tens of thousands of
  tokens to produce a paragraph per step.
- One mechanism serves two features. Asking from a step is a turn in the
  session by necessity; making the narration one too means one wire format,
  one route, one revival path.
- The answer lives in the transcript, so the transcript remains the only
  store of the explanation — which the idea document asked for.

## What was ruled out

**The ephemeral query.** Clean transcript, but the cost above, and a second
model explaining the first one's work. It is the right shape for a
classifier with a two-word answer, which is what the titler is; it is the
wrong shape for an account of a day's work.

## What follows

- **Narration and questions appear in the transcript** as user turns. They
  fold behind a chip, like a command expansion, so the reading is not
  interrupted; nothing is hidden.
- **Narration runs on request, never on open.** It is a turn on the owner's
  subscription. A stale narration is shown as stale and a new one offered.
- **The feature is Orbital-sessions-only.** A turn needs a session the Runner
  can send to or revive; a session live in a terminal is neither. This is
  accepted, not worked around: Orbital is meant to be the developer's right
  hand, not a viewer for the terminal.
- **A narration that comes back malformed is a visible failure**, not a
  silent absence. The page says the narration did not parse and keeps the
  button.
