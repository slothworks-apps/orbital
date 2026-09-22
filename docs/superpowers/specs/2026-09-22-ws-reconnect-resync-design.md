---
id: 2026-09-22-ws-reconnect-resync-design
title: WS reconnect resync and heartbeat
type: spec
status: done
domain: web
related:
  - first-turn-can-outrun-the-ws-subscription
---

# WS reconnect resync and heartbeat

## The bug

The transcript panel freezes until a manual reload (View > Reload in the
desktop app, F5 on dev). Two independent holes combine into it:

1. **Nothing catches up after a reconnect.** `OrbitalSocket` reconnects and
   resubscribes, but the transcript history is fetched over REST exactly once
   per page load (`historyLoaded[id]` in the store) and the server replays
   nothing: transcript tails start at EOF and the runner publishes
   fire-and-forget. Every message published while the socket was down is
   permanently invisible to that page. If the outage swallowed the tail of a
   turn and the session then idles, nothing new ever arrives — frozen forever.
2. **A dead-but-not-closed socket is never detected.** Neither side sends any
   keepalive. A connection that dies without firing `onclose` (sleep/wake, a
   suspended renderer) never triggers the reconnect at all, and freezes with
   no banner.

## Agreed behaviour

### Server heartbeat

The server sends an application-level heartbeat frame
(`{"type":"heartbeat"}`, no `topic`) to every connected `/ws` socket every
`WS_HEARTBEAT_INTERVAL_MS`. It must be an application-level frame, not a WS
protocol ping: browsers answer protocol pings transparently and page
JavaScript never sees them, so only a real frame can feed the client's
watchdog. The interval lives in `Hub.handleSocket` (injectable for tests) and
is cleared when the socket closes. Frames without a `topic` are already
ignored by the client's router, so old clients are unaffected.

### Client watchdog

`OrbitalSocket` tracks when it last received *any* frame. If nothing arrives
for `HEARTBEAT_TIMEOUT_MS` (several times the server's interval, so one lost
frame doesn't kill a healthy connection), it closes the socket itself, which
flows into the existing `onclose` → reconnect path. The timeout is injectable
via `OrbitalSocketOptions` for tests. The watchdog runs only while the socket
is open.

### Resync on reconnect

When the store's `wsStatus` transitions to `open` after having been `closed`
(detected in `setWsStatus` — the initial `connecting → open` does not count),
the store runs `resyncAfterReconnect()`:

- `loadInitial()` — already the authoritative full snapshot: sessions, order,
  pending decisions, tags, rules, settings, errors. This covers every
  `sessions`/`errors` event missed during the outage.
- Transcript caches are dropped (`transcripts: {}`, `historyLoaded: {}`) so
  the next `select()` of any session refetches. Dropping instead of merging is
  deliberate: `select()`'s merge *prepends* unseen fetched messages, which
  puts a missed tail in the wrong place; a cache rebuilt from REST cannot be
  mis-ordered. Pages fetched via `loadOlder` are lost — re-fetchable at the
  cost of one click.
- For the currently selected session the fresh page is fetched *before* the
  caches are swapped, so the open transcript never flashes empty: the new
  `transcripts` map is set in one `set()` holding just that session's fetched
  page.

## Not doing

- No server-side replay/journal per topic. REST is already the catch-up
  channel; duplicating it into the WS layer buys nothing.
- No merge of missed messages into existing transcript arrays (mis-ordering
  risk above).
