---
id: 2026-09-30-human-wait-tools-design
title: Human wait — questions, plan approvals and permission prompts leave the work time
status: done
type: spec
domain: stats
related:
  - 2026-09-20-session-stats-design
tags:
  - server
  - web
  - runner
---
# Human wait leaves the work time

Canvas: `Feature - Stats.dc.html`, artboards 10i (dashboard, switch on),
10j (drilldown, switch on), 10k (parts and states, off vs on) and the
human-wait rows of 10e. Where this spec and the canvas disagree on a
visual value, the canvas wins; where they disagree on what can be
measured, this spec wins.

## Problem

The stats spec (`2026-09-20-session-stats-design` § Time) rules that
waiting for the user is not a metric: it measures where the laptop was,
not the work. Three kinds of wait break that rule today, because they
sit inside tool calls:

- `AskUserQuestion` — the `tool_use` → `tool_result` gap is the user
  answering.
- `ExitPlanMode` — the gap is the user approving the plan.
- A permission prompt — the gap of the prompted tool includes the time
  the prompt sat unanswered.

One question left over lunch inflates `localToolMs`, tops the
slowest-tools leaderboard, skews its histogram and stretches a
waterfall lane. A prompt answered inside a subagent inflates
`subagentMs` the same way.

## Rule

Human wait never enters work time, on any surface, with the switch on
or off. By default it contributes only a count: how often the session
needed the user. With the switch on, its time is shown beside the
work-time split, never inside it.

## What can be measured

| wait | Orbital-run session | terminal session |
|---|---|---|
| `AskUserQuestion` | transcript gap | transcript gap |
| `ExitPlanMode` | transcript gap | transcript gap |
| permission prompt | runner: prompt shown → answered | not separable — `†`, upper bound |

Permission waits are Orbital-only on purpose. The CLI's transcript does
not record them, and a CLI hook could only say when a prompt appeared,
never when it was answered — so installing one into the user's
`~/.claude/settings.json` would buy nothing measurable. Terminal
sessions keep the existing `†` caveat, and their count line omits
permissions rather than showing a partial number (a rejected prompt is
visible in the transcript, an approved one is not).

MCP elicitation (a server asking the user for input) would be the same
kind of wait; the runner does not handle it today, so it is out of
scope until it does.

## Server

### Human-wait tools (transcript)

- `toolKind` gains a fourth kind, `human`, for the names in a new
  `HUMAN_WAIT_TOOLS` set, checked the same way `SUBAGENT_TOOLS` is.
- A closed `human` run does **not** touch `toolCalls`, `toolErrors`,
  `localToolMs`, `mcpMs`, `subagentMs` or `toolBreakdown`. It goes to
  `humanWaitMs` and to `humanBreakdown: Record<string, ToolStat>` — the
  same shape as `toolBreakdown`, so the switch-on leaderboard reuses its
  rendering. A separate record rather than a tag inside `toolBreakdown`
  keeps every existing consumer (leaderboard, window rollups, series,
  the `slow-mcp` rule) correct without learning a new kind.
- Human runs are not `ToolRun`s for the findings: a rejected plan is
  not a failing tool, so `error-loop` and `obese-tool-result` never see
  them.
- `TurnSegment.tools` still lists them, with `kind: 'human'`, so the
  drilldown can link to the transcript and draw the break.

### Permission waits (runner)

- `Runner.decide` already knows both ends of a permission decision:
  `createdAt` when it parks, and the moment `settle` runs. It records
  each settled `permission`-kind decision in a new table
  `permission_waits`: session id, `tool_use_id`, the dispatching
  `Agent` tool_use id when the prompt came from a subagent (`agentID`
  set; the runner resolves it from the subagent it is tracking), shown
  at, answered at, and the outcome (allowed / denied / aborted).
  Question and plan decisions are not recorded here — the transcript
  already times them for every session.
- A decision auto-allowed without parking (`bypassPermissions`) waited
  for nobody and is not recorded.
- `computeStats` takes the session's permission waits as a second input
  and stays pure. For each wait:
  - the prompted tool's duration drops by the wait (clamped at 0) and the
    wait goes to `humanWaitMs` and `permissionBreakdown`;
  - when the prompt came from a subagent, the dispatching `Agent` run's
    duration drops by the same amount, so `subagentMs` is work only.
- A session with no recorded waits (a terminal session, or an Orbital
  session from before this change) computes exactly as today.
- `permissionTimed` is true for every session whose `sessions.source` is
  not `terminal`. It is derived when the rollup is served, not stored: a
  revive turns a terminal session's `source` into `web`, and a stored
  copy would be wrong until the next re-index. An Orbital session from before
  this change counts as timed with no waits: its old prompt waits stay in
  its tool time. Accepted — it only touches history, and telling those
  sessions apart would need a cut-over marker nothing else uses.

- `STATS_VERSION` goes up, so stored rollups re-index under the new
  definition. Nothing re-indexes on a new wait by itself: the wait is
  recorded when the prompt is answered, before the tool's result reaches
  the transcript, and the index pass that result line triggers reads it.
  Every stats computation — indexer, live and end-of-session recompute,
  the drilldown's timeline — reads the waits.

### Wire shape

`StatsRollup` (stored and served) gains:

| field | type | what |
|---|---|---|
| `humanWaitMs` | number | every human wait, summed |
| `humanBreakdown` | `Record<string, ToolStat>` | `AskUserQuestion`, `ExitPlanMode` |
| `permissionBreakdown` | `Record<string, ToolStat>` | permission waits, keyed by the prompted tool's name; `ms` and `buckets` are the wait, not the tool |
| `permissionTimed` | boolean | see above |

`TurnSegment.tools[]` entries gain `kind: 'human'` for the two tools, and
an optional `waitMs` on any other entry: the permission wait cut out of
it (for an `Agent` entry, the waits of the prompts its subagent raised).

`GET /api/stats/overview` gains, on `totals` and `previousTotals`:
`humanWaitMs`, `questionCount`, `planCount`, `permissionCount` (timed
sessions only) and `timedSessionCount`; on each `daySeries` day,
`humanWaitMs`; and `toolLeaderboard.human` — rows for
`AskUserQuestion`, `ExitPlanMode` and `permission` (calls, ms, p50,
and per prompted tool for the last), a row with no calls left out, the
permission row absent without a timed session in range.

## Web

- **Default (switch off):** a count only — "asked you N× · M plan
  approvals · K permissions", on the dashboard, the drilldown and the
  quick-stats dialog. `K permissions` appears only when the range holds
  Orbital-run sessions, and counts only those. No human wait appears in
  the leaderboard or the waterfall, and no human time appears anywhere;
  the wait is part of the not-busy remainder, like idle.
- **Switch:** "Show time spent waiting on you", at the right end of the
  `/stats` filter row, off by default. A persisted preference, not a
  filter: the server setting `stats_show_human_wait` (`'true'` /
  `'false'`), never in the URL query, not in Settings. The quick-stats
  dialog follows it and has no switch of its own.
- **Switch on (10i–10k):**
  - a `WAITING ON YOU` tile in the slot beside the busy / split tile,
    with the time and the count line; the busy tile and the four
    category percentages are identical to the switch-off state;
  - the leaderboard gets a `YOU` group below the ranked list —
    `AskUserQuestion`, `ExitPlanMode`, `permission prompts` — unranked,
    no share bar;
  - the waterfall cuts the lane with one fixed-width break: every wait of
    the turn merges into it at the first one's place (`14m ×3`, hover
    lists each), the lane total on the right stays work only. A prompt
    raised inside a subagent is placed before the `Agent` call it was
    cut from — 10j draws it mid-call, but nothing records how far into
    the subagent's run it came.
- The `†` caveat marks terminal sessions: the quick dialog badges one
  `TERMINAL` and puts `†` on its local tools; the drilldown states the
  rule once, under the waterfall, in 10j's words.

## Tests

- `computeStats`, on a transcript holding an `AskUserQuestion` and an
  `ExitPlanMode` run with long gaps next to ordinary tools: neither gap
  is in `localToolMs`, `toolCalls` or `toolBreakdown`; `humanWaitMs`
  and `humanBreakdown` counts match; a rejected `ExitPlanMode`
  (`is_error`) raises no `error-loop`.
- `computeStats` with permission waits: the prompted tool's time drops
  by the wait; a subagent's wait comes off `subagentMs`; a wait longer
  than its tool clamps at 0; no waits → the same rollup as today.
- Runner: a parked-then-settled permission decision records one row
  with both timestamps; a `bypassPermissions` auto-allow and a question
  record none.

## Settled with Claude Design

- 10j and 10e now describe permission timing as the runner's, for
  Orbital-run sessions only.
- Several waits in one turn merge into one break (10k), so a lane never
  runs past the track.
