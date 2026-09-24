---
id: sessions-topic-events-land-once-per-frame
title: Sessions-topic events land once per frame, and a session-topic event catches them up first
type: adr
status: in-force
domain: web
related:
  - a-reopened-session-shows-the-transcript-it-was-left-with
  - resource-usage-pass-2026-09-24
tags:
  - web
  - performance
  - websocket
---

# Sessions-topic events land once per frame, and a session-topic event catches them up first

## The problem

Every `sessions`-topic frame (`upsert`, `status`, `remove`) was a store write
of its own, and each write notifies every zustand subscriber. A busy turn
sends many of them. Finding 6 of [[resource-usage-pass-2026-09-24]] asked for
them to be batched per animation frame.

Delaying an event is not free. The server publishes a session's row on
`sessions` and its turn on `session:<id>`, and `applySessionEvent`'s `status`
handler reads the row: a `status` for a session whose `upsert` is still
queued is dropped, and with it the `turnResultSeen` bookkeeping behind the
crash row.

## What was decided

- Only the socket's `sessions` handler (App and the detached SessionWindow)
  batches, through `queueSessionsEvent`. Every other caller — Sidebar,
  TagsRules, the deep link, tests — keeps `applySessionsEvent`, which
  applies at once.
- The queue flushes on the next `requestAnimationFrame`, or after
  `SESSIONS_FLUSH_FALLBACK_MS` if no frame comes (a hidden window draws
  none, and the queue must not grow while it stays hidden). A flush is one
  store write: each event is reduced against the state the ones before it
  left (`sessionsEventPatch`), and the side effects (the refetch of an
  unknown id, closing the agent panel of a removed session) run after the
  write.
- `applySessionEvent` flushes the queue before it does anything, so the
  two topics keep the order they had on the wire. `loadInitial` flushes
  before it seats its snapshot, so a queued event cannot undo part of it.
- `session:<id>` events are not batched. Their order is the transcript's
  order, and the `delta` path is already coalesced on the server.

## What was rejected

**Batching inside `OrbitalSocket`.** The socket could hold a topic's frames
and hand them over per frame, but the handler would still write the store
once per event; the write is what costs. It would also have delayed the
`session:<id>` topic's ordering relative to it in ways the socket cannot see.

**Batching `applySessionsEvent` itself.** Its synchronous callers read the
store straight after calling it.

**Only `requestAnimationFrame`.** Chromium stops frames in a hidden window,
and the desktop app hides its window rather than closing it.
