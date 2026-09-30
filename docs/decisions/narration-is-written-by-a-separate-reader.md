---
id: narration-is-written-by-a-separate-reader
title: The walkthrough's narration is written by a separate reader of the visible record
status: in-force
type: adr
domain: walkthrough
related:
  - 2026-09-30-narrate-out-of-band-design
  - walkthrough-narration-is-a-turn-in-the-session
  - narrate-can-lock-a-session-out
  - ephemeral-title-queries
tags:
  - walkthrough
  - narration
---
# The walkthrough's narration is written by a separate reader of the visible record

Supersedes [[walkthrough-narration-is-a-turn-in-the-session]].

## The problem

The narration was a turn in the session: the model that did the work was
asked to recount it, including what it had weighed and not done. On
2026-09-29 the API's safeguards refused that turn with
`[reasoning_extraction]`, and the refusal stayed in the session's history,
so every later turn was refused as well ([[narrate-can-lock-a-session-out]]).

Two things were wrong with the old shape, not one:

- A failure of the narration became a failure of the session.
- It asked a model to recount its own reasoning, which is not something to
  rely on across models or safeguard changes.

## The decision

Decided 2026-09-30 with the owner.

- **The narration is a one-shot query outside the session**, like the
  titler's ([[ephemeral-title-queries]]): no persisted transcript, no tools,
  one turn. Whatever it does, the session never sees it.
- **Its input is the visible record only**: the user's messages, the
  assistant's visible text, the steps and their calls. Thinking blocks are
  never passed. The prompt asks for what the record shows, not for what the
  model had in mind.
- **The model is a setting**, Sonnet by default, so the feature does not
  depend on whatever the session runs.
- **Asking from a step is removed.** It was the same shape — a turn in the
  session asking why — and nothing about it survives the move out.
- **An opt-in switch asks Orbital's sessions to comment aloud** on what they
  change and why. That puts more of the "why" into the visible record, where
  the reader can use it.

## What was ruled out

- **Keeping the turn and relying on rewind.** Rewind gets a locked session
  back, but a feature whose normal use needs a recovery path is broken.
- **A purely mechanical narration** (one intent per user message, the
  agent's own text as the summary). Always works, costs nothing, but gives
  no summary and no grouping across messages. The steps already stay
  readable when the query fails, so it is not needed as a fallback either.
- **Using the session's own model.** Better quality on some sessions, but
  slower, more expensive, and different from session to session.

## What follows

- The narration no longer comes from the session's own memory: what was
  weighed and rejected is visible only if someone said it. The commentary
  switch is the answer to that, not a return to asking the session.
- The whole transcript is paid for again, uncached, on each run — the cost
  the old ADR ruled the ephemeral query out for. The digest is capped, and
  narration runs on request, never on open.
- The narration is stored in Orbital's database, not in the transcript. A
  session narrated before this change is not narrated after it.
- The narration no longer needs a session Orbital can send to, so it works
  on a session that is running, ended, or live in a terminal.
