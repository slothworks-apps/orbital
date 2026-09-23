---
id: the-new-session-dialog-loses-its-first-prompt
title: The New session dialog loses its first prompt
status: backlog
type: idea
domain: sessions
related:
  - 2026-09-20-composer-design
  - 2026-09-23-ide-bridge-design
  - the-browser-mints-the-session-id
  - runner-pins-the-session-id
  - swept-sessions-need-a-tombstone
tags:
  - sessions
  - composer
---
# The New session dialog loses its first prompt

The New session dialog carries a composer. You pick a directory, a model and a
mode, and then you write your opening message inside the dialog — and that
composer is a second one, with its own mount, its own attachment state, its own
send semantics (⏎ makes a newline there and sends in the panel) and its own
place in every feature that touches composing.

Neither the Claude Code CLI nor the desktop app works that way. In both, you
start a session and then you type into the session. Orbital's extra step buys
nothing the panel's own composer does not already do, and it costs a surface
that has to be kept in step with the real one forever: the composer spec has
already had to describe the dialog separately, and the IDE bridge ran straight
into it — the editor slot would have to exist twice, and the second one cannot
work the way the first does because there is no session for it to belong to.

## What it would be

**The dialog creates the session and closes.** The session opens in the panel
with an empty composer and the caret in it. Everything about composing then has
exactly one implementation.

A session nobody types into is then a possible outcome, so **empty sessions get
swept** — the same way ended ones already fall out of the map. Orbital already
has the machinery and the vocabulary for a session that stops mattering.

## The question it opens

**What is a session with no prompt?** Today `Runner.start()` takes a prompt and
starting is what spawns the SDK query. A session created without one is a row
in the database and no process — so either the row waits and the process starts
on the first message, or the process starts immediately and idles.

That is not a detail to settle in passing:

- the id is minted in the browser and pinned by the runner
  ([[the-browser-mints-the-session-id]], [[runner-pins-the-session-id]]), and
  both currently happen around a first turn;
- a row with no process has no status the map knows how to draw — it is not
  working, not waiting on input, and not ended;
- sweeping it needs to distinguish "never used" from "used and quiet", and
  [[swept-sessions-need-a-tombstone]] says a swept session cannot simply
  vanish.

None of this is hard, but it is the actual work — the dialog change itself is
deletion.

## What it unblocks

The IDE bridge's slot in the dialog (canvas `Feature - IDE bridge` 20b-6) stops
being wanted rather than being built: with no composer in the dialog there is
nothing for a selection to attach to, and the panel's slot — which already
exists and already works — is the only one. That question was open and this
closes it, which is why it was worth writing down before anyone builds the
second slot.
