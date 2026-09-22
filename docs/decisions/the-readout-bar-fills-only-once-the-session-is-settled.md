---
id: the-readout-bar-fills-only-once-the-session-is-settled
title: The readout row's bar fills only once the session has stopped working
type: adr
status: in-force
domain: stats
related:
  - 2026-09-20-session-stats-design
  - the-drilldown-split-bar-is-a-share-of-busy
  - the-stats-row-reads-when-the-stats-are-written
---

# The readout row's bar fills only once the session has stopped working

`the-drilldown-split-bar-is-a-share-of-busy` settled what the unfilled part of
a stats bar means: nothing. The drilldown's SPLIT tile is normalised to busy
time, so it always fills, and idle is stated in words instead.

Canvas 10g's readout row does not follow that rule, and says so in as many
words. Its resting state is 47 / 24 / 17 / 12 — a hundred percent, a full
track. Its live state is 61 / 19 / 8 / 4 — ninety-two, with the note "bar does
not fill the track while the session runs".

## The decision

**The row's bar is a share of busy time for a settled session and a share of
the wall clock for a running one** (`panels/SessionStatsRow.tsx`):

```
denominator = working ? max(busy, elapsed) : busy
```

The two readings are the same claim seen at two moments. A finished session is
a finished measurement: the question is where its time went, and the four
categories are the whole answer. A running session has a remainder that is not
"idle between turns" but "not over yet", and a bar that filled anyway would be
the one thing on the row that looked the same at turn 3 and at turn 40.

`max` rather than the clock alone: tool calls run in parallel, so busy can
legitimately exceed elapsed, and the bar then fills rather than overflowing
its track — the same honesty the drilldown's idle line keeps by never printing
a negative remainder.

The dialog behind the row is unaffected: 10f's TIME SPLIT sums to 100 and
carries `elapsed · idle` in the line above it, exactly as the drilldown does.
The row is the only bar in the feature whose denominator changes, because it
is the only one that is read while the number it draws is still moving.
