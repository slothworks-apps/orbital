---
id: the-stats-row-reads-when-the-stats-are-written
title: The stats row reads when the stats are written, not when the session moves
type: adr
status: in-force
domain: stats
related:
  - 2026-09-20-session-stats-design
  - the-readout-bar-fills-only-once-the-session-is-settled
---

# The stats row reads when the stats are written, not when the session moves

Canvas 10g puts a live readout in the detail panel: busy time, cost and the
four-colour split, "numbers still moving" while the session runs. The row has
to get those numbers from somewhere, and the spec budgets variant A at **one
compute pass per 10 turns per open session** — the number 10h was weighed
against.

## What actually writes a rollup

A session's `session_stats` row is rewritten by three cadences, and by nothing
else:

| writer | when |
|---|---|
| `LiveSessionStats.feed` | every `STATS_LIVE_RECOMPUTE_TURNS` turns of a tailed session |
| `LiveSessionStats.end` | once, as the session ends |
| `indexProjects` | when a transcript's mtime or size changed, on a 500ms-debounced watch |

`GET /api/stats/sessions/:id` returns that stored row verbatim. It recomputes
only the per-turn timeline, which is derived on the spot and never stored.

The first implementation of this row re-read the endpoint whenever the
session's status changed — twice a turn, on the belief that a turn landing
rewrites the rollup. It does not. Those reads paid a full transcript (plus
subagent files) reparse for numbers that were, most of the time, byte for byte
what was already on screen, roughly twenty times the budget above, and they
still could not make the row current: between live recomputes the stored row
is up to ten turns old however often it is read.

Nothing announced the writes. `ApiSession` — what the session list and every
WS upsert carry — has no stats fields, and adding them would put a rollup on
every row in the store for the benefit of the one session that is open.

## The decision

**Every `session_stats` write announces itself**, on the session's own WS
topic: `{ event: 'stats' }` on `session:<id>`. The hook is
`upsertSessionStats` (`server/src/stats/store.ts`), which all three cadences
already go through, so the announcement cannot drift from the write — a
listener is threaded into `LiveSessionStats` and `indexProjects`, and
`server/src/index.ts` turns it into `hub.publish`. The payload is the id
alone: what changed is a row in the database, and the client re-reads the
endpoint, which is the only place the stored row and the derived cost are
assembled.

**The row reads on panel open, then only on that signal.** The store counts
the events per session (`statsRevision`), and the row's hook re-reads when the
count moves (`panels/SessionStatsRow.tsx`). A signal is coalesced over
`STATS_RELOAD_COALESCE_MS`, because the live recompute and the indexer's pass
can write the same rollup milliseconds apart and two reparses for one change
is one wasted.

**The dialog keeps a bounded poll** while it is open on a live session
(`QUICK_STATS_REFRESH_MS`). It is the one surface that draws the turn
timeline, which is derived per request and so is not part of the stored row
the signal announces. It stops when the dialog closes.

**The dialog issues no request of its own.** The row passes down what it read,
so opening the dialog costs nothing and the two can never print different
numbers.

## Consequences

Reads now track writes: a session nobody is writing to costs nothing, and
every read returns something that changed. `hub.publish` is a no-op for a
topic nobody is subscribed to, so the announcement costs one map lookup per
write for the sessions no window has open.

The row is therefore exactly as current as the stored row is, which for a
tailed live session means the indexer's debounced pass — a few times a turn
while the transcript is growing — and the live recompute every ten turns. It
is not per-token live, and 10g does not ask it to be.

The endpoint no longer recomputes the timeline on every read: `GET
/api/stats/sessions/:id` gates it behind `?timeline=1`, which only the two
surfaces that draw the waterfall pass — the drilldown always, and the row while
its dialog is open. The row's own reads, which fire on every `stats` event and
show only the rollup and cost, omit the flag and get an empty `turns`, so a
busy session's write bursts no longer each pay a full transcript (+ subagents)
reparse the row would throw away.

A session the stats index has never seen answers 404, and a response without a
rollup is dropped rather than rendered — both land the row in its empty state
rather than in an error toast over the panel. A readout is not worth
interrupting the transcript for.
