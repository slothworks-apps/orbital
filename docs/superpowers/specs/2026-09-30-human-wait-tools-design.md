---
id: 2026-09-30-human-wait-tools-design
title: Human-wait tools — AskUserQuestion and ExitPlanMode leave the work time
status: draft
type: spec
domain: stats
related:
  - 2026-09-20-session-stats-design
tags:
  - server
  - web
---
# Human-wait tools leave the work time

## Problem

The stats spec (`2026-09-20-session-stats-design` § Time) rules that
waiting for the user is not a metric: it measures where the laptop was,
not the work. Two tools break that rule without anyone noticing,
because they look like ordinary tool calls:

- `AskUserQuestion` — the `tool_use` → `tool_result` gap is the time the
  user took to answer.
- `ExitPlanMode` — the gap is the time the user took to approve the plan.

Both are counted as local tools today, so one unanswered question left
over lunch inflates `localToolMs`, tops the slowest-tools leaderboard,
skews its histogram and stretches a waterfall lane.

## Rule

`AskUserQuestion` and `ExitPlanMode` are **human-wait tools**. Their
duration never enters work time, on any surface, with the switch on or
off. What they contribute by default is a count: how often the session
needed the user.

## Server

- `toolKind` gains a fourth kind, `human`, for the names in a new
  `HUMAN_WAIT_TOOLS` set, checked the same way `SUBAGENT_TOOLS` is.
- A closed `human` run does **not** touch `toolCalls`, `toolErrors`,
  `localToolMs`, `mcpMs`, `subagentMs` or `toolBreakdown`. It goes to:
  - `humanWaitMs` — the summed gap;
  - `humanBreakdown: Record<string, ToolStat>` — the same shape as
    `toolBreakdown` (calls, errors, ms, buckets), so the switch-on
    leaderboard can reuse its rendering.

  Keeping them in a separate record rather than tagging rows inside
  `toolBreakdown` means every existing consumer (leaderboard, window
  rollups, series, the `slow-mcp` rule) stays correct without learning
  a new kind.
- Human runs are not `ToolRun`s for the findings: a rejected plan is
  not a failing tool, so `error-loop` and `obese-tool-result` never see
  them.
- `TurnSegment.tools` still lists them, with `kind: 'human'`, so the
  drilldown can link to the transcript and draw them when the switch is
  on.
- `STATS_VERSION` goes up, so every stored rollup is re-indexed under
  the new definition. The new fields are persisted the same way as
  `toolBreakdown`.

## Web

- **Default:** the stats surfaces show a count only, e.g. "asked you 4×,
  1 plan approval". No human-wait tool appears in the leaderboard or the
  waterfall, and no human time appears anywhere.
- **Switch:** "Show time spent waiting on you", on the stats page
  itself, not in Settings. It is persisted as the server setting
  `stats_show_human_wait` (`'true'` / absent), so it survives restarts
  and sessions; the quick-stats dialog follows the same setting without
  a switch of its own.
- **Switch on:** human wait appears as its **own item beside** the
  work-time split, never inside it, so busy time and its categories
  read the same with the switch on or off. The two tools return to the
  leaderboard, marked as waiting on the user, and the waterfall draws
  them in a way that cannot be mistaken for a work lane.
- Placement and look of the switch, the count and the switch-on item
  come from Claude Design (brief below); this spec does not fix them.

## Out of scope

Permission-prompt waits inside ordinary tool runs in terminal sessions
stay as they are: the transcript does not separate them from the run,
and the existing on-screen caveat covers them.

## Tests

`computeStats`, on a transcript holding an `AskUserQuestion` and an
`ExitPlanMode` run with long gaps next to ordinary tools:

- neither gap is in `localToolMs`, `toolCalls` or `toolBreakdown`;
- `humanWaitMs` and `humanBreakdown` counts match;
- a rejected `ExitPlanMode` (`is_error`) raises no `error-loop`.

## Claude Design brief

> Feature - Stats: `AskUserQuestion` and `ExitPlanMode` no longer count
> as tool time — their duration is the user answering, not work. Needed:
> (1) a count shown by default on the dashboard, drilldown and
> quick-stats dialog ("asked you N×, M plan approvals"); (2) a switch on
> the stats page, "Show time spent waiting on you", off by default;
> (3) with it on, human wait as its own item beside the work-time split,
> never one of its categories; the two tools in the leaderboard marked
> as waiting on the user; and a waterfall treatment that does not read as
> a work lane. Constraints: the work-time split must look identical with
> the switch on or off; keep to the existing 10e palette.
