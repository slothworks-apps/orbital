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
# Session stats — where the time and tokens go

Canvas: `Feature - Stats.dc.html` (to be designed before implementation;
the artboards there are the source of truth for every visual value not
repeated here).

Orbital already parses every transcript. This spec adds a statistics
layer on top: a global dashboard answering "how much of a session do I
spend waiting on Anthropic vs. running tools, what does it cost, and
what am I doing wrong", plus a per-session drilldown. Findings are
deterministic heuristics in v1 — an LLM "analyse this session" pass is
explicitly out of scope and can arrive later without schema changes.

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

The only time base is **agent busy time = `apiMs` + `toolMs`**. Session
wall time and "waiting for the user" are deliberately not metrics: a
gap between the end of a turn and the next human message measures where
the laptop was, not the work. `computeStats` still classifies those
gaps — but only to discard them, so they pollute neither bucket. With
no user-wait metric there is also no idle threshold to tune.

- **`apiMs`** — for each `requestId` group, the gap from the preceding
  main-chain entry (user prompt or tool_result) to the group's first
  entry. Covers queue + inference + streaming.
- **`toolMs`** — the gap from a `tool_use` to its matching
  `tool_result`. Split three ways by tool name for display:
  - **local** (Read, Edit, Bash, …),
  - **MCP** (name starts with `mcp__`) — network-bound, where the
    surprising waits hide,
  - **subagents** (`Task`) — wall time of the whole sub-run.
- Sidechain entries are excluded from the parent's timeline entirely
  (their wall time is the parent's `Task` gap).
- Honest caveat, surfaced as a label in the UI: in terminal sessions a
  tool gap includes any permission-prompt wait; we cannot separate it,
  for MCP no better than for Bash.

### Tokens and cost

Summed once per `requestId`: `inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheCreationTokens` (plus the 5m/1h split),
`thinkingTokens`. Sidechain usage is summed separately as
`subagentTokens` so the parent's numbers stay honest.

Cost is **never persisted**. The server config carries a small pricing
table per model (input / output / cache-write 5m / cache-write 1h /
cache-read rates); cost is computed at read time, so a price change
never forces a reindex. Tokens are the primary display; money is
derived.

Tool result size is measured in characters of `toolUseResult` (a
chars/4 token estimate is fine for display; we never bill by it).

### Heuristic findings (v1)

Each finding is `{rule, severity, evidence}` where evidence points at
concrete entries (uuid) so the UI can link into the transcript.
Thresholds are named constants in `server/src/stats/`; starting values
below are the spec's, tune freely later.

| rule | fires when | starting threshold |
|---|---|---|
| `cache-burn` | session cache-hit ratio low, or a large `cache_creation` re-appears mid-session (TTL expired after a pause) | ratio < 0.5; re-creation > 20k tokens |
| `obese-tool-result` | a single `toolUseResult` is huge — names the tool | > 30k chars |
| `error-loop` | ≥ N consecutive `is_error` tool_results, or the same tool failing repeatedly | N = 3 |
| `overgrown-session` | input tokens per turn keep climbing and total `cache_creation` is high — "consider a fresh session" (token/turn based, never duration) | input/turn > 100k and turns > 50 |
| `chatty-turns` | many API requests each producing little output | > 20 turns with median output < 100 tokens |
| `slow-mcp` | an MCP server's median call latency is high | median > 5s over ≥ 3 calls |

## Data model

New table `session_stats`, 1:1 with `sessions`, written by the indexer
and the watcher tail in the same pass that already runs `extractMeta`:

- time: `apiMs`, `toolMs`, `localToolMs`, `mcpMs`, `subagentMs`,
  `turns`
- tokens: `inputTokens`, `outputTokens`, `cacheReadTokens`,
  `cacheCreationTokens`, `cacheCreation5mTokens`,
  `cacheCreation1hTokens`, `thinkingTokens`, `subagentTokens`
- tools: `toolCalls`, `toolErrors`, `toolBreakdown` JSON
  (`{name: {calls, errors, ms, resultChars}}`)
- `findings` JSON (the heuristic hits)
- `statsVersion` int — bump it when a definition changes and the
  indexer recomputes even unchanged files (the mtime/size
  short-circuit additionally checks the stored version)

## Computation

`computeStats(entries: TranscriptEntry[]): SessionStats` — a pure
function in `server/src/stats/`, no DB, testable on fixture
transcripts. The same function serves both the indexer rollup and the
on-demand per-session timeline (below); the timeline is derived data
and is never persisted.

## API

- `GET /api/stats/overview?days=&project=&model=` — pure SQL over
  `session_stats ⋈ sessions` (filters on `lastAt`, `projectDir`,
  `resolvedModel`). Returns totals (tokens, cost, busy-time split
  API / local / MCP / subagents), a per-day series for trends, the tool
  leaderboard, and recent findings.
- `GET /api/stats/sessions/:id` — the stored rollup plus an on-demand
  timeline: the transcript is re-read and `computeStats` returns
  per-turn segments (requestId, start, apiMs, individual tool calls
  with durations, per-turn tokens) for the waterfall.

## Web UI

New real route `/stats`, branched on pathname in `main.tsx` the same
way `/sandbox` is. Content per the canvas:

- **Dashboard** — stat tiles (tokens, cost, busy-time split), per-day
  stacked bars of the time split, cache-hit-ratio trend, findings feed
  linking to sessions, tool leaderboard with MCP separated.
- **Session drilldown** — `/stats?session=<id>` and linked from the
  findings feed and from the session's DetailPanel: turn waterfall,
  per-session tiles, findings with links to the exact transcript spots.

Charts follow the dataviz rules; the visual design is authored in
Claude Design first and implementation is verified against the
artboards value by value.

## Edge cases

`computeStats` must survive: missing or out-of-order timestamps;
`tool_use` with no `tool_result` (aborted turn — the gap is discarded,
attributed to nothing); old transcripts without `requestId` (fallback:
each assistant entry is its own turn); compact/summary entries; empty
sessions. All degrade to partial stats, never to a throw.

## Testing

Per the repo's testing rules — parsing and pure logic earn tests, UI
rendering does not:

- fixture tests for `computeStats`: usage dedup per `requestId`, gap
  classification including the discard of user-wait gaps, sidechain
  exclusion from time plus separate token accounting, the MCP name
  split, error loops, each heuristic's firing and non-firing case
- route tests for both endpoints (filters, unknown session, cost
  derivation from the pricing config)
- no pinning of dashboard pixels or chart values

## Out of scope

- LLM-based session analysis (heuristics only in v1)
- Any change to how transcripts are written
- Historical price tracking (the pricing table is "current prices";
  past sessions are priced at today's rates)
