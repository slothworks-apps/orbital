---
id: context-usage-has-one-source
title: Context usage has one source, and the detail panel drops its token grid
status: in-force
type: adr
domain: sessions
related:
  - context-fill-arc
  - models-come-from-the-sdk
tags:
  - context
  - usage
---
# Context usage has one source, and the detail panel drops its token grid

## The problem

Canvas 1b gives the detail panel's header a three-column grid — INPUT,
OUTPUT, CACHE READ — above a context bar. All four numbers were derived in
the browser from the `turn_result` WebSocket event, whose payload the store
kept in a `usage` map keyed by session id.

That map is memory and nothing else. It is never persisted, never hydrated
from the API, and only ever written by a live event. So the numbers existed
only in a tab that happened to be open when a turn ended. Reload, or open a
session that finished its last turn five minutes ago, and all four read
`—` — permanently, for a session that was in every other respect fully
described. The owner had never seen the grid carry a value.

Beside it, the map's context arc was drawn from `ApiSession.contextUsedTokens`:
a column on the session row, written by the server from the SDK's `result`
and `compact_boundary` messages and republished on the `sessions` topic. Same
underlying measurement, one surface reading it from a durable row and the
other from a transient event. `lib/usage.ts` already carried a comment
warning that the two could drift; they had in fact already drifted into
"the arc shows a number, the bar beside it shows an em dash".

## What was decided

**One number, one function.** `contextFractionFor(session, models, windows)`
in `lib/usage.ts` reads `contextUsedTokens`, divides by the known window and
clamps to [0, 1]. The map's `contextFillFor` and the panel's bar both call
it; neither computes a fraction of its own. It answers only "how full", never
"should this be shown" — those gates genuinely differ per surface and stay at
the call sites.

**The INPUT/OUTPUT/CACHE READ grid is deleted.** It is not being fixed,
because it was not wanted: what the owner tracks is how full the context is,
not how a turn's tokens were billed. Persisting three more columns to feed
cells nobody reads is cost without a reader.

**The canvas was redrawn to match, rather than being departed from.** Canvas
1b now carries the gauge alone, promoted into the space the grid held: the
measurement as a 21px mono read-out in the level's own ink, `/ 200k ctx`
beside it at 11px, and a 6px track notched at the two thresholds. Artboard
`1b-alt` holds its five states — unmeasured, under, over, over-window,
terminal — and a rejected variant B that merged the gauge into the status
row; B was dropped because it caps the read-out at 17px to save one row, and
the number being the largest thing in the header is the point. The notches
are drawn from the configured thresholds, not from 1b's literal 50 / 80,
which are only the defaults the artboard happens to show.

With it go `extractUsageTokens`, the `UsageTokens` type, the store's `usage`
slice and the `UsageStat` cell. The `turn_result` event stays on the wire and
in the reducer — it still clears the crash flag and stamps
`lastTurnResultAt` — but its `usage` payload is now unread.

## What follows from it

**The read-out quotes the measurement, the bar quotes the clamp.** A session
measured past a mis-learned window reads `500k / 200k ctx` over a full bar,
rather than having its numerator quietly rounded down to the denominator. A
right-hand note (`OVER WINDOW`) carries the discrepancy, so the pair does not
read as a bug; the only other note is `NOT MEASURED YET`, which says which of
the two things an em dash means. An ordinary fill gets no note.

**The panel keeps an ended session's last reading; the map does not.** Canvas
1i drops the arc at `ended` because a crowded map does not need gauges for
sessions that are over. A detail panel is not crowded, and the last known
fill is exactly what someone opening a finished session wants. The two gates
differ on purpose.

**The cadence is per turn, not continuous.** `contextUsedTokens` is rewritten
when a turn ends and when a compaction reports its new size — so a long turn
shows the previous turn's figure throughout. That was already true of the
grid it replaces; making it live during a turn is a separate change against
the `context-fill-arc` spec, which chose turn-end deliberately.

**Terminal sessions still show nothing.** The indexer reads no usage out of a
transcript, so `contextUsedTokens` is null for them and always will be. The
bar is gated on `source !== 'terminal'` rather than left to dash, per the
owner's earlier ruling.
