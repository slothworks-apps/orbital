---
id: panel-pair-ceiling-includes-the-gutter
title: The subagent pair's 75% ceiling counts the gutter between the panels
type: adr
status: in-force
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
  - subagent-panel-width-has-no-drag-handle-yet
tags:
  - web
  - store
  - subagents
  - layout
---

# The subagent pair's 75% ceiling counts the gutter between the panels

## The problem

Task 8's brief (`.superpowers/sdd/2026-09-22-subagent-transcript-panel-design/task-8-brief.md`)
gave `resolvePanelPairWidths`'s ceiling check as `ceiling = 0.75 * V`,
compared directly against `D + S` — the detail and subagent panel widths
summed, with no mention of the 16px gutter between them. The first
implementation (task 8, before this fix round) followed that literally:
`detailWidthPx + subagentWidthPx <= ceiling`.

That reading is wrong, and the brief's own author confirmed it during code
review. Two readings of "how much of the viewport does the pair occupy"
disagree, and the disagreement is not academic — it surfaces at a viewport
already exercised by this codebase's own test suite:

At `V = 1000`, `ceiling = 750`:

```
exclusive (the original, WRONG implementation):
  450 + 380 = 830 > 750
  D' = 750 - 380 = 370, S stays 380
  => { detailWidthPx: 370, subagentWidthPx: 380 }

inclusive (gutter counted as occupied space):
  450 + 16 + 380 = 846 > 750
  D' = max(360, 750 - 16 - 380) = 360
  360 + 16 + 380 = 756 > 750, so S must also shrink:
  S' = max(320, 750 - 16 - 360) = 374
  => { detailWidthPx: 360, subagentWidthPx: 374 }
```

10px apart on the detail panel, 6px apart on the subagent panel, and one
reading has the detail panel still comfortably above its floor while the
other has it pinned there. A viewport 1000px wide is not a corner case —
`detail.test.tsx`, `spacemap.test.tsx` and `app.test.tsx` all already
render at or near it.

## The evidence

Two independent signals both point at the inclusive reading, not the
exclusive one the brief's prose literally described:

1. **The design canvas's own worked example.** `Feature - Subagent
   panel.dc.html`, the note beside the 11b pairing diagram, reads: *"panels
   together **846px** = 59% of 1440."* 846 = 450 (detail) + 380 (subagent) +
   16 (gutter). The canvas's own arithmetic puts the gutter INSIDE the sum
   it calls "panels together" — it is not treated as free space the ceiling
   ignores.

2. **The brief's own "roughly 1010px" threshold.** Under the exclusive
   formula, the detail panel first hits its 360px floor at `ceiling = 360 +
   380 = 740`, i.e. `V = 740 / 0.75 ≈ 987`. Under the inclusive formula it
   hits the floor at `ceiling = 360 + 16 + 380 = 756`, i.e. `V = 756 / 0.75 =
   1008`. The brief's own illustrative number — "roughly 1010px" — matches
   the inclusive reading almost exactly and misses the exclusive one by
   more than 20px of viewport.

Neither signal is decisive on its own (both differences are small enough to
have been rounding, or a canvas note that happened to add three numbers
together for a different reason), but both point the same way, and there is
no signal pointing the other way.

## What was decided

The ceiling check is gutter-inclusive: `detailWidthPx + PANEL_GUTTER_PX +
subagentWidthPx <= ceiling`, and the gutter is carried through every step
that follows — the detail panel's yield-first share is `ceiling -
PANEL_GUTTER_PX - subagent`, and the subagent panel's own fallback share
(step 5) is `ceiling - PANEL_GUTTER_PX - DETAIL_PANEL_MIN_PX`. See
`resolvePanelPairWidths` in `web/src/store/store.ts` for the implementation
and `PANEL_GUTTER_PX`'s own comment for why that constant is now exported
from `store.ts` rather than kept as a private copy in each render site
(`App.tsx` and `SpaceMap.tsx` both import it, as of this fix round) — the
ceiling math and the actual on-screen gutter have to agree on the same
number, or the ceiling becomes a statement about a size nothing draws.

The reasoning, independent of either piece of evidence: the ceiling is a
statement about how much of the viewport the pair OCCUPIES. The 16px
between the two panels is space neither panel's content can use — it is
occupied exactly as much as either panel's own width is — so a ceiling that
pretended it were free understates the true footprint of "the two panels
open together."

`web/src/test/store.test.ts` pins the V=1000 example above as its own test
("locks the gutter-inclusive reading in at V=1000, where it disagrees with
the (wrong) exclusive one") specifically so the two readings can never be
silently swapped back without a very visible test failure quoting both
numbers.

## What was rejected

**The exclusive reading (`D + S <= ceiling`, no gutter), matching the
brief's literal prose.** This was the FIRST implementation, and it shipped
in task 8's initial commit — code review is what caught the disagreement
documented above. Kept here as the "what was rejected" case rather than
silently erased, since the brief's prose really did say this and a future
reader diffing the brief against the code deserves to find out why they no
longer match.

## Consequences

- `resolvePanelPairWidths`'s ceiling comparison, its detail-panel fallback,
  and its subagent-panel fallback all changed by exactly `PANEL_GUTTER_PX`
  wherever a gutter sits between the quantity being compared and the
  ceiling. Every existing test built on the old exclusive numbers needed
  its expected values recomputed (`store.test.ts`, `detail.test.tsx`,
  `spacemap.test.tsx`, `app.test.tsx`) — done in the same fix round as this
  ADR.
- `PANEL_GUTTER_PX` moved from two private, duplicated 16px constants
  (`App.tsx`, `SpaceMap.tsx`) to one export in `store.ts`. This was flagged
  as an accepted minor duplication in task 8's own review ("if a third site
  ever appears, that is the moment to extract") — `resolvePanelPairWidths`
  needing the same 16px for its ceiling math is that third site, so the
  extraction happened here rather than adding a third private copy.
