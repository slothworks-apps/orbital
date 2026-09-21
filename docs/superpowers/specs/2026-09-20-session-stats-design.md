---
id: 2026-09-20-session-stats-design
title: Session stats — where the time and tokens go
status: draft
type: spec
domain: stats
tags:
  - indexer
  - server
  - web
---
# Session stats — where the time, tokens and money go

Canvas: `Feature - Stats.dc.html`, artboards 10a–10h. 10e carries the
colour/metrics/behaviour tables — the source of truth for every visual
value not repeated here. Where this spec and the canvas disagree, the
canvas wins.

Orbital already parses every transcript. This spec adds a statistics
layer on top: a dashboard answering "is the agent waiting on the API or
on tools, where do the tokens and dollars go, and what am I doing
wrong", a per-session drilldown, and a quick-stats dialog in the
session detail panel. Findings are deterministic heuristics — an LLM
"analyse this session" pass is explicitly out of scope.

## Source data

Verified against real transcripts in `~/.claude/projects/`:

- Every entry has a millisecond `timestamp`. Assistant entries carry
  `requestId`, `message.model` and a full `message.usage`:
  `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens` (with the 5m/1h ephemeral split under
  `cache_creation`), and `output_tokens_details.thinking_tokens`.
- The CLI writes **one assistant entry per content block**, so several
  entries share a `requestId` and each repeats the same `usage`. A turn
  is the group of entries with one `requestId`; usage MUST be counted
  once per `requestId`, never per entry.
- Tool runs are `tool_use` → `tool_result` pairs. MCP calls are
  ordinary tools named `mcp__server__tool`. `tool_result` entries carry
  `toolUseResult` (the payload whose size we measure) and `is_error`.
- Subagent traffic sits in the same file with `isSidechain: true`. The
  parent's `Task` tool_result already covers the subagent's wall time.

## Metric definitions

### Time

The time base is **agent busy time**, split into exactly four
mutually-exclusive categories that sum to busy time, never to
wall-clock (10e's category table, colours included):

- **API wait** — request sent → last token received. Per `requestId`
  group: the gap from the preceding main-chain entry to the group's
  first entry.
- **local tools** — `tool_use` → `tool_result` for built-in tools.
- **MCP servers** — the same gap for `mcp__*` tools.
- **subagents** — `Task` dispatch → subagent final message. Sidechain
  entries are excluded from the parent's own lanes; their nested API
  and tool time rolls up here, never double-counted.

"Waiting for the user" is deliberately not a metric: a gap between the
end of a turn and the next human message measures where the laptop
was, not the work. `computeStats` still classifies those gaps — but
only to discard them. Wall-clock (`lastAt − firstAt`) and the derived
remainder (`elapsed − busy`, displayed as "idle" context in tiles) are
shown for orientation only and never enter the split.

Honest caveat, on screen and not in a tooltip (10b): in terminal
sessions a tool gap includes any permission-prompt wait; local-tool
totals in `plan` and `acceptEdits` sessions are an upper bound.
Waterfall lanes get a `†` mark where a prompt is known to have
happened — best-effort, only for Orbital-run sessions where the runner
saw the decision; terminal sessions carry the blanket caveat alone.

### Tokens and cost

Summed once per `requestId`: `inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheCreationTokens` (plus the 5m/1h split),
`thinkingTokens`. Sidechain usage is summed separately as
`subagentTokens` so the parent's numbers stay honest.

Cost is **never persisted** as money. The pricing table (per model:
input / output / cache-write 5m / cache-write 1h / cache-read) **ships
with the build** — no per-token pricing overrides (canvas brief, 10a
scope). Cost is computed at read time from the token columns, so a
price bump in a new build reprices history without a reindex. The
drilldown's "where the money went" panel (10b) splits cost four ways:
uncached input / cache read / cache write / output.

Tool result size is measured in characters of `toolUseResult`; tokens
are estimated at chars/4 for display and leaderboard ranking, never
for billing.

### Heuristic findings

Four rules at launch (canvas brief; `overgrown-session` and
`chatty-turns` from the draft were cut). Each finding is
`{rule, severity, evidence}`; evidence names the rule, the session,
the measured numbers and the offending turn/entry uuids so the UI can
link straight into the waterfall and transcript. Thresholds are named
constants in `server/src/stats/`; values below are 10d/10e's and the
implementation verifies against them.

| rule | fires when | severity |
|---|---|---|
| `cache-burn` | cache hit < 60% over ≥ 10 turns | CRITICAL when uncached input ≥ $10 in the session, else WARNING |
| `obese-tool-result` | one tool result ≥ 25k tokens (chars/4) | WARNING |
| `error-loop` | the same failing tool call repeated ≥ 5× | CRITICAL |
| `slow-mcp` | an MCP tool's p50 ≥ 5s over ≥ 10 calls, **server-wide across sessions in the window** | INFO, never higher |

Storage split: the first three are per-session facts, computed at
index time and stored in `findings`. `slow-mcp` and the RESOLVED state
(a rule whose last 5 sessions are clean; drops off the feed after 7
days) are **window-level** — derived at query time in the overview
endpoint, never stored.

`cache-burn`'s severity depends on price; since findings persist only
the rule and measured tokens, severity is also resolved at read time
from the shipped pricing table.

Evaluation cadence (10b): rules run over the stored transcript when
the session ends, and every 10 turns while it is live (the watcher
tail triggers the recompute).

## Data model

New table `session_stats`, 1:1 with `sessions`, written by the indexer
and the watcher tail in the same pass that already runs `extractMeta`:

- time: `apiMs`, `localToolMs`, `mcpMs`, `subagentMs`, `turns`
  (busy = the four summed; elapsed comes from `sessions`)
- tokens: `inputTokens`, `outputTokens`, `cacheReadTokens`,
  `cacheCreationTokens`, `cacheCreation5mTokens`,
  `cacheCreation1hTokens`, `thinkingTokens`, `subagentTokens`
- tools: `toolCalls`, `toolErrors`, `toolBreakdown` JSON —
  `{name: {calls, errors, ms, resultChars, buckets}}` where `buckets`
  is a log₂ duration histogram (boundaries 250ms → 64s) so the
  overview can compute window-level per-tool p50 exactly enough for
  the leaderboard and `slow-mcp`
- `findings` JSON (per-session rules only, see above)
- `statsVersion` int — bump it when a definition changes and the
  indexer recomputes even unchanged files (the mtime/size
  short-circuit additionally checks the stored version)

## Computation

`computeStats(entries: TranscriptEntry[]): SessionStats` — a pure
function in `server/src/stats/`, no DB, testable on fixture
transcripts. The same function serves the indexer rollup, the
on-demand per-session timeline, and the quick-stats dialog; the
timeline is derived data and is never persisted.

## API

- `GET /api/stats/overview?window=24h|7d|30d|all&project=&model=` —
  pure SQL over `session_stats ⋈ sessions` (filters on `lastAt`,
  `projectDir`, `resolvedModel`; they apply to every panel). Returns
  totals (tokens, cost split, busy-time split, wall-clock), the
  comparison against the previous window of the same length (10a's
  "+18% vs prev 7d"), the per-day series, the cache-hit-ratio series,
  the tool leaderboard (both rankings: slowest by time with p50, most
  expensive by estimated result tokens), and the findings feed —
  per-session findings merged with the derived `slow-mcp` and
  RESOLVED entries.
- `GET /api/stats/sessions/:id` — the stored rollup plus an on-demand
  timeline: the transcript is re-read and `computeStats` returns
  per-turn segments (requestId, start, apiMs, individual tool calls
  with durations and `†` where known, per-turn tokens) for the
  waterfall and the "slowest turns" list.

## Web UI

Real routes, branched on pathname in `main.tsx` the same way
`/sandbox` is: **`/stats`** (dashboard) and
**`/stats/session/<id>`** (drilldown). Filters live in the URL query.
Layout, colours, states and interactions per the canvas:

- **Dashboard — 10a.** Header filter bar (window 24h/7d/30d/all,
  project, model), three stat tiles (total tokens, cost with
  per-session average and prev-window delta, agent busy time with the
  four-way split bar over wall-clock context), per-day stacked bars
  (API wait at the base, hover lifts the day and shows the four
  durations + total), cache-hit-ratio trend with the ≥ 80% target
  guide, tool leaderboard (slowest / most expensive tabs, MCP badge),
  findings feed. Clicking a finding opens the drilldown scrolled to
  the waterfall with the offending turn pre-highlighted; back returns
  to the feed at the same scroll position.
- **Drilldown — 10b.** Session header (path, id, model, span, turns,
  "open transcript"), tiles (busy of elapsed, tokens, cost, split),
  turn waterfall (longest-first / chronological toggle, paged, `†`
  marks, on-screen permission caveat), the session's findings with
  "jump to turn" links, "where the money went" cost split.
- **Empty state — 10c.** Fresh install shows the explainer and CTAs,
  never zeroed charts.
- **Finding card — 10d.** Severity treatments (CRITICAL / WARNING /
  INFO / RESOLVED), hover state, every card states rule id, severity,
  session and measured evidence.
- **Quick-stats dialog — 10f.** Opened from the session detail panel
  (not a page): busy/tokens/cost tiles, time split with elapsed +
  idle context, slowest turns, the session's findings, "full stats →"
  link to the drilldown. Live sessions show the same dialog with a
  blinking current-turn segment.
- **Detail-panel trigger — 10g vs 10h.** Variant A: a 34 px readout
  row (busy time, cost, split bar legible without a click; one
  compute pass per 10 turns per open session). Variant B: a plain
  26 px STATS chip that reads nothing until clicked, with a skeleton
  dialog while parsing. The dialog is identical either way; **the
  choice is deferred to implementation** and A downgrades to B by
  dropping the readout, no redesign.

Number formats and every spacing/colour value: 10e's tables, verified
value by value during implementation.

## Edge cases

`computeStats` must survive: missing or out-of-order timestamps;
`tool_use` with no `tool_result` (aborted turn — the gap is discarded,
attributed to nothing); old transcripts without `requestId` (fallback:
each assistant entry is its own turn); compact/summary entries; empty
sessions (< 1 turn: the trigger row reads "session stats · —" and is
not clickable). All degrade to partial stats, never to a throw.

## Testing

Per the repo's testing rules — parsing and pure logic earn tests, UI
rendering and 10e's pixel values do not:

- fixture tests for `computeStats`: usage dedup per `requestId`, gap
  classification including the discard of user-wait gaps, sidechain
  exclusion from lanes plus roll-up into subagent time and tokens,
  the MCP name split, duration histogram bucketing, each per-session
  rule's firing and non-firing case
- window-level derivations: `slow-mcp` p50 from merged histograms,
  RESOLVED after 5 clean sessions, prev-window comparison
- route tests for both endpoints (filters, unknown session, cost
  derivation from the shipped pricing table)

## Out of scope

- LLM-based session analysis
- `overgrown-session` and `chatty-turns` heuristics (cut in design;
  candidates for a later rules pass)
- cross-machine aggregation, CSV export, custom heuristics, budget
  alerts, per-token pricing overrides (canvas brief)
- historical price tracking — sessions are priced at the shipped
  table's current rates
