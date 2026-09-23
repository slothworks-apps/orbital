---
id: folded-tool-run-duration-needs-every-item-timed
title: A folded tool run shows its summed duration only when every item in it has one
type: adr
status: in-force
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
tags:
  - web
  - transcript
  - subagents
---

# A folded tool run shows its summed duration only when every item in it has one

## The problem

Canvas 11b draws a folded run of tool calls with a summed duration —
`"4 tool calls · Read ×3, Grep ×1 · 6.2s"`. Any one call in that run can lack
a usable duration: `toolDurationMs` (`web/src/panels/ToolRow.tsx:62-69`)
returns `undefined` when either timestamp is missing (a transcript from
before timestamps were stamped, or an SDK frame that carried none), when the
call has not finished yet (no `tool_result` to time against), or when the
gap comes out negative (a clock correction mid-session — fixed in a
follow-up commit, 3a73683, after `Math.max(0, …)` was found silently turning
that case into a fabricated `0s`). A run's summary has to decide what its
total means when one member's own duration is one of these unknowns.

## What was decided

`summarizeToolRun` (`web/src/panels/TranscriptView.tsx:130-151`) accumulates
`durationMs` by adding each item's `toolDurationMs`, but the moment any one
item's value is `undefined` the running total itself becomes `undefined` and
stays that way for the rest of the loop:

```ts
if (durationMs !== undefined) {
  const d = toolDurationMs(item.toolUse, item.toolResult)
  durationMs = d === undefined ? undefined : durationMs + d
}
```

One missing timestamp or one still-running call in an otherwise-timed run
blanks the WHOLE total. `formatToolDuration(undefined)` then renders nothing
for the summary line, the same way it renders nothing for a single untimed
row.

The reasoning is the same one already governing the per-row case
(`web/src/lib/format.ts`'s own comment on `formatToolDuration`, written for
task 6 and reused here): the row-level rule refuses to fabricate a duration
rather than show `0s` or `—` for an unknown one, because a fabricated number
"would claim a duration for a call that may have taken a minute." A partial
sum presented as *the* total is the same lie in a different shape — it would
read as "this run took 6.2s" when in fact one of its calls took an unknown
and possibly much longer amount of time. Silently excluding the unknown item
from the sum (rather than blanking the whole total) would produce exactly
that understated number with nothing marking it as partial.

## What was rejected

**Summing only the items that have a duration, and showing that partial
total.** Rejected because a partial sum with no visual marker reads as
complete — a reader has no way to tell "6.2s, all four calls timed" from
"6.2s, three of four timed, one unknown" without the summary saying so, and
the summary line has no room budgeted for that caveat (canvas 11b's example
is a plain number).

**Falling back to `0` for any item with no duration, matching the old
row-level bug this same principle was already fixing elsewhere.** Rejected
for the same reason the row-level `0s` was: it is not conservative, it is
wrong in the direction that understates.

## Consequences

- A run containing even one still-running call shows no duration at all
  until every call in it has finished — the summary line is duration-silent
  for the whole run's lifetime up to that point, not partially informative
  along the way.
- `ToolRow`'s own row-level duration and `summarizeToolRun`'s folded-run
  duration are guaranteed to agree on what counts as "no duration" because
  both call the same `toolDurationMs`/`formatToolDuration` pair — this was
  true before this decision and remains the reason the summing rule could be
  expressed as "propagate `undefined`" rather than a second, independent
  judgment call.
