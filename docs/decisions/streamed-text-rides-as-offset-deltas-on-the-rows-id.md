---
id: streamed-text-rides-as-offset-deltas-on-the-rows-id
title: Streamed text rides as offset deltas, and the finished block reuses the row's id
type: adr
status: in-force
domain: transcript
related:
  - 2026-09-24-streaming-output-design
  - the-browser-mints-the-session-id
tags:
  - server
  - web
  - transcript
---

# Streamed text rides as offset deltas, and the finished block reuses the row's id

## The problem

Streaming an answer means the client sees a row change many times before it
is final, and then sees the final block arrive as an ordinary message. Two
things can go wrong: the same frame delivered twice (the launch's
subscription and the selection's overlap on purpose, see
`launchSubscriptions` in `web/src/store/store.ts`), and the final block
landing beside its streamed twin instead of on top of it.

## What was considered

- **Publish the whole text so far on every tick.** Idempotent and trivial to
  apply, but the wire carries the square of the answer's length: a long
  thinking block would send megabytes over a minute.
- **Publish raw deltas and let the client append.** Small, but a duplicated
  frame doubles a word, and there is nothing in the frame to notice it by.
- **Reconcile the final block on the client** by role and position among
  partial rows. Works while the SDK emits one frame per block in order, and
  breaks silently the day it does not.

## What was decided

- A delta carries its **offset** — the length of everything published for
  that row before it. A duplicate has an offset behind the row and is
  ignored; the frame stays small.
- The **server mints the row id** when the block starts, and the complete
  block **reuses that id** when its text equals the streamed text. The
  client's existing dedupe by id becomes the reconciliation: a held row that
  is partial is replaced, a held row that is final drops the event. No
  ordering assumption survives the server.
- Deltas are **coalesced per row on the server**, so re-render count and
  frame count are bounded by a constant per second, not by the token rate.

## Consequences

- A tab that joins mid-stream sees a tail-only row until the complete block
  replaces it. Accepted: the head is a few hundred milliseconds old at most,
  and the alternative (a snapshot on subscribe) is a second publish path.
- Text equality is the match. A block whose final text differs from its
  deltas (it should not) gets a fresh id and the partial row is finalised at
  the turn's end with the streamed text, never dropped.
