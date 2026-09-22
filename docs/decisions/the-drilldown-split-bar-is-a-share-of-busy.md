---
id: the-drilldown-split-bar-is-a-share-of-busy
title: The drilldown's SPLIT bar is a share of busy time, and idle is stated in words
type: adr
status: in-force
domain: stats
related:
  - 2026-09-20-session-stats-design
---

# The drilldown's SPLIT bar is a share of busy time, and idle is stated in words

Two artboards disagree about what the unfilled part of a bar means.

10e's colour table gives the track — `rgba(150,205,255,.07)` — the meaning
"idle inside a turn, unfilled bar". Read literally, the drilldown's SPLIT bar
would be scaled to the session's elapsed time and the gap at its end would be
the time nobody was working.

10b draws it otherwise. Its SPLIT tile carries four segments of 47 / 24 / 17 /
12 percent, which sum to exactly 100, on a session whose neighbouring tile
reads "1h 12m of 1h 37m elapsed". The bar is a share of busy time; no track
shows at all.

## The decision

**The SPLIT bar is a share of busy time** (`SessionDrilldown.tsx`), the same
normalisation the dashboard's AGENT BUSY TIME tile already uses, so the four
categories can be compared against each other on both screens without a reader
having to notice which denominator a bar is on.

**Idle is stated in words**, on the BUSY TIME tile's sub-line: `of 1h 37m
elapsed · 25m idle`. It is computed as `max(0, elapsed − busy)` and printed
only when it is positive (controller ruling). Tool calls can run in parallel,
so busy time can legitimately exceed the wall clock; in that case the tile
prints the two honest numbers and no idle, rather than a negative remainder or
a bar that has been quietly rescaled to hide the overlap.

Drawing idle as a track was rejected for a second reason beyond 10b's
geometry: 10e's own table ends the track's row with "never labelled, never in
the legend", so an idle drawn as track would be the one quantity on the tile
with no way to read its value.
