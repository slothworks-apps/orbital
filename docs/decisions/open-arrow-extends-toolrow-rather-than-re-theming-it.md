---
id: open-arrow-extends-toolrow-rather-than-re-theming-it
title: The Agent/Task row's OPEN → is added to today's ToolRow, not a new moon-chip row
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

# The `Agent`/`Task` row's `OPEN →` is added to today's `ToolRow`, not a new moon-chip row

## The problem

Task 9's brief (`.superpowers/sdd/2026-09-22-subagent-transcript-panel-design/task-9-brief.md`)
asks for the parent transcript's `Agent` tool row to gain an `OPEN →`
control (spec § 5, "The parent transcript's agent row"). Canvas 11a draws
that row as its own distinct treatment — a small hue-tinted disc icon in
place of the `⚙` glyph, `moon · <label>` instead of `Agent: <description>`,
an accent-tinted border (`oklch(85% .12 205 / .5)`) and fill
(`oklch(85% .12 205 / .08)`) instead of today's neutral `rgba(150,205,255,.1)`
/ `rgba(4,8,16,.45)`, and the model name where the duration usually sits —
with `OPEN →` as one more element inside that already-redrawn row.

## What was decided

Only the literal ask: an `OPEN →` control, appended to the RIGHT end of
today's `ToolRow` header — same place `· 0.3s` (the duration) and the
running dot already sit — rendered only for an `Agent`/`Task` row whose
`toolUseId` matches a live entry in the session's own `subagents`
(`web/src/panels/ToolRow.tsx`). Everything else about the row is untouched:
same `⚙` glyph, same `salientInput`-driven label (now also recognising
`Agent`, not just `Task` — the CLI rename `SUBAGENT_TOOLS`
(`server/src/transcript/subagents.ts`) already accounts for), same neutral
border/fill, same collapse/expand behaviour.

## What was rejected

**Rebuilding the row as canvas 11a's own moon-chip treatment** — new icon,
new border/fill accent, `moon · <label>` wording, the model name in the
duration's slot. Rejected for three reasons together, not one:

- the task brief's own words are narrower than the canvas — "gains an
  `OPEN →` control", not "gains a new visual identity". Where this repo's
  spec and its canvases disagree on BEHAVIOUR the spec wins (root
  `CLAUDE.md`'s own rule for this document set); the brief is the sharper
  statement of behaviour here.
- the accent chip needs data `ToolRow` does not have today — the model name
  specifically lives on the subagent's own transcript (`subagentModelFrom`
  in `lib/subagentPanel.ts`), not on the `Subagent` the row is joined
  against, so a faithful redraw would need a second data fetch (or a second
  join) for a cosmetic swap the brief never asked for.
- a full redraw touches the same shared component every other tool call in
  every transcript renders through, raising the regression surface for a
  task whose actual, load-bearing requirement is the control itself.

**A brand-new, `Agent`-only row component** instead of extending `ToolRow`.
Rejected because it would duplicate the collapse/expand chrome, the
INPUT/RESULT rendering, and `ToolRunGroup`'s folding behaviour (an
`Agent`/`Task` call still folds into a run of tool calls like any other —
canvas 11a's own row sits inside the SAME transcript flow, not a separate
lane) for the sake of one appended control.

## Consequences

- `web/src/test/transcript.test.tsx`'s `describe('ToolRow: OPEN → subagent
  control', ...)` asserts the control renders/joins/opens correctly and that
  a non-matching or absent `subagents` list renders nothing — it does NOT
  assert on the row's colour or icon, because this decision leaves both
  unchanged.
- If canvas 11a's fuller treatment is ever wanted, it is a follow-up task
  with its own data plumbing (the model name above all), not a difference
  this task's diff should be read as having skipped by oversight.
