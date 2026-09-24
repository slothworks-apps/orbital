---
id: the-tail-yields-to-the-runner
title: A session's transcript tail runs only while the Runner does not own it
type: adr
status: in-force
domain: sessions
related:
  - 2026-09-22-ws-reconnect-resync-design
  - first-turn-can-outrun-the-ws-subscription
  - a-reply-is-in-the-transcript-file-but-not-in-the-open-panel
tags:
  - server
  - websocket
  - runner
---

# A session's transcript tail runs only while the Runner does not own it

## The problem

A subscribed `session:<id>` topic can be fed two ways. A session the
Runner owns publishes off the SDK stream. A session it does not own — a
terminal session, or an Orbital session that has ended — gets a
`TranscriptTail` on its transcript file, started at EOF by the topic's
first subscriber.

The choice between the two was made once, at first subscribe, and never
revisited. Two things change ownership after that moment:

- **A revive.** Sending into an ended session resumes it through the
  Runner (`deliverToSession`). The tail started for the ended session kept
  running, so every reply arrived twice: once off the SDK stream, once
  again a moment later when the CLI wrote the same reply into the file.
  Reproduced against the desktop app's own server on 2026-09-23 with a
  throwaway session: `OK2` as `<id>:1993:0` from the Runner, then `OK2`
  as `<uuid>:0` from the tail, ~200 ms apart. The client dedupes by id and
  the two ids differ, so both rows showed.
- **An end.** A session subscribed while the Runner had it got no tail.
  After the Runner released it, nothing fed the topic at all — a terminal
  resuming that session would have been silent in the open panel until it
  was reselected.

With the idle timeout at its default, every message into a session older
than that goes through the revive path, so the duplicate was the common
case for anyone opening an idle session and continuing it.

## What was decided

The tail runs exactly while **the topic has a subscriber and nobody in this
process owns the session**, and both edges hand over:

- The Runner claiming a session — a launch, a revive, an autoheal — stops
  its tail.
- The Runner releasing one — its end — starts a tail at the current EOF if
  the topic still has subscribers.

Both ride the Runner's existing `onOwnership` callback in
`server/src/index.ts`, which already fires on exactly those two edges for
the autoheal claim. The tail block moved above autoheal, because autoheal's
claims are the first calls to reach it.

On the release edge the Runner still lists the session for one more call
(`finish()` reports the release before it deletes the entry), so the
"does anyone own it" check reads `runner.status(id)` — `ended` at that
point — rather than `runner.active()`.

Writes made while the Runner owned the session are not replayed when the
tail restarts: they were published off the stream as they happened, and
the restarted tail begins at the new EOF like any other.

`server/test/tailHandoff.test.ts` pins both edges against a real socket.

## Ruled out

- **Dedupe on the client by content.** The two copies have different ids
  by construction (`<sessionId>:<seq>:<block>` versus `<uuid>:<block>`),
  so it would have to match on text and role, which is exactly the
  matching the optimistic user-turn path already has to hedge with image
  refs. Two feeds is the bug; hiding one is not a fix.
- **Never tailing a `web`-source session.** Simpler, but a terminal can
  resume any session, Orbital's included, and the panel would go silent
  for it.
- **Stopping the tail in the revive route only.** Misses the launch and
  autoheal claims, and the release edge entirely. The Runner already
  announces every ownership change in one place.
