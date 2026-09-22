---
id: the-segmented-control-is-one-component-with-named-sizes
title: The segmented control is one component, with sizes named for where they
  are used
status: in-force
type: adr
related:
  - 2026-09-22-header-gauges-design
tags:
  - ui
---
# The segmented control is one component, with sizes named for where they are used

## The problem

Adding the `Session stats in the header` row to Settings made the fourth
hand-rolled copy of the same control: a row of buttons in a bordered,
overflow-hidden shell, one of them filled with the accent, the others
divided by a hairline on their left. The three that already existed were

- `Settings.tsx` — the Lineage depth stepper (canvas 1h)
- `StatsFilterBar.tsx` — the window filter (canvas 10a)
- `ToolLeaderboard.tsx` — the panel's tabs, with a local `TabButton`

`web/CLAUDE.md` already rules on this: a variant that does not exist yet
belongs in the component, so every caller gets it and it stays testable.
Four copies of a control's chrome is how the fifth one drifts.

The three do not agree on their measurements, and that is the part that
needed deciding rather than just extracting:

| call site | radius | padding | type |
|---|---|---|---|
| Lineage depth | 8px | `12px 7px` | mono 12px |
| stats window | 8px | `14px 7px` | mono 11.5px |
| leaderboard tabs | 7px | `11px 5px` | mono 10.5px |

## What was decided

**One `ui/Segmented`, with three sizes named `row`, `filter` and `tab`.**

Named for where they are used rather than `sm`/`md`/`lg`, because the three
do not order: `row` carries the largest type and the tightest horizontal
padding, `filter` the reverse. A t-shirt scale would be a lie the next
person has to discover by reading the table. Each size cites its artboard.

The alternative — unifying the three onto one or two sizes — was rejected.
It would have moved pixels on three shipped screens that the canvas
specifies individually, to buy nothing but a shorter table.

**`aria-pressed` buttons inside a `role="group"`, not a radio group.** This
is the shape all three copies already had, it is what the control looks
like (a row of toggles where exactly one is down), and it is what the
existing tests query. A radio group would have been the more literal
reading of "one choice out of N", but it comes with arrow-key roving focus
that none of these four call sites had, and adopting it silently would
change keyboard behaviour on three screens this decision is only passing
through.

**`minItemWidth` is a prop, not a size.** Only the lineage stepper needs it
— its labels are single characters and the segments are otherwise as ragged
as the glyphs in them. Baking a 40px floor into the `row` size would push it
onto the word-labelled rows that share that size.

## What follows from it

`Select` is still the answer when the options do not all fit on the line, or
when there are more than a handful. `Segmented` is for the few-and-visible
case.

A new segmented control picks a size from the table rather than restating
the chrome. If a screen genuinely needs a fourth set of measurements, it
gets a fourth named size here — not a local copy.
