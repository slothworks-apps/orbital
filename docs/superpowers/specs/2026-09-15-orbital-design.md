# Orbital — Design Spec

**Date:** 2026-09-15
**Status:** Approved pending final review
**Visual design:** https://claude.ai/design/p/df77470e-1384-436c-8b25-5e01acfc497f?file=Orbital.dc.html
(export artboards as PNG into `docs/design/` once available — the canvas link requires claude.ai auth)

## Overview

Orbital is a local web app that visualizes and manages Claude Code sessions as a
2D space map: sessions are planets, subagents are orbiting moons. It shows live
terminal sessions (read-only), full session history, tag-based organization, and
can spawn and drive its own sessions through the Claude Agent SDK (full chat with
the agent from the browser).

Runs only on the owner's Mac, binds to `127.0.0.1`, no authentication.

## Goals

- Overview of all Claude Code sessions: active (terminal + web) and historical
- Free-form tags (work, personal, oncall, experiments, …) with glob auto-rules and manual overrides
- Open any historical session and continue the conversation from the web (SDK resume)
- Spawn new sessions from the web with a chosen cwd and permission mode
- Live, animated space visualization driven by real session/subagent state

## Non-goals

- Sending input into sessions running in a terminal (their `/tmp/cc-socks` protocol is undocumented; terminal sessions are watch-only)
- Interactive permission prompts in the UI (per-session preset mode only; `canUseTool` is a possible later addition)
- Embedding a real terminal (xterm.js/PTY) — the chat view renders structured messages, not a TUI
- Remote access, multi-user, auth

## Architecture

Monorepo `~/Projects/slothworks/orbital`:

```
orbital/
├── server/          # Fastify + TypeScript
│   ├── watcher/     # active sessions + live transcript tail
│   ├── indexer/     # history scan → SQLite
│   ├── runner/      # Agent SDK sessions
│   └── api/         # REST + WebSocket
└── web/             # React + Vite + TypeScript + Tailwind + react-three-fiber
```

One server process. One WebSocket connection per client, multiplexed by topic.
REST for everything else.

### Data sources (Claude Code internals — undocumented, parse defensively)

| Source | Purpose |
|---|---|
| `~/.claude/sessions/<pid>.json` | live session registry: sessionId, cwd, name, status (`idle`/`working`), kind, timestamps |
| PID liveness (+ `procStart`) | filter stale registry files |
| `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | transcripts (history + live tail); encoded-cwd = path with `/` → `-` |
| `Task` tool calls inside transcripts | subagent detection: tool_use without result = subagent running (moon orbiting); result received = finished |

A version bump of Claude Code may change these formats. All parsers must fail
soft (skip unparseable records, log, never crash the server).

### Watcher

- chokidar on `~/.claude/sessions/` → in-memory map of live sessions; verify PID
  is alive and `procStart` matches. Push `upsert`/`remove` + status changes to
  the `sessions` WS topic.
- On demand (client subscribed to `session:<id>`): tail the session's `.jsonl`
  from last byte offset via fs.watch, parse appended lines, push as `message`
  events. Track open Task tool calls to emit subagent state.

### Indexer

- On startup and on transcript file changes: incremental scan of
  `~/.claude/projects/**/*.jsonl`; skip files whose `(mtime, size)` match the
  stored `indexed_mtime`/`indexed_size`.
- Extract per session: cwd, first user message (title, ~120 chars), first/last
  message timestamps, message count, file size.
- Apply tag rules on index and on rule changes.

### Runner (Agent SDK)

- `@anthropic-ai/claude-agent-sdk`, streaming input mode: per-session message
  queue consumed by an async generator passed to `query()`.
- Web sessions must behave exactly like the interactive CLI:
  ```
  systemPrompt: { type: 'preset', preset: 'claude_code' }
  settingSources: ['user', 'project', 'local']
  cwd: <chosen directory>
  permissionMode: <chosen at session start: plan | acceptEdits | bypassPermissions>
  ```
  This loads CLAUDE.md, memory, skills, plugins, slash commands, settings
  permissions, and `.mcp.json` MCP servers. MCP servers requiring interactive
  OAuth must be authenticated beforehand from the CLI.
- Lifecycle: process stays alive between turns (waiting on its input stream).
  Idle timeout 30 min → kill process; the next prompt revives the session with
  `resume: sessionId` (also how historical/ended sessions are continued).
- Interrupt: Stop button → SDK interrupt; session returns to idle.
- Transcripts are written to `~/.claude/projects/` by the SDK itself, so web
  sessions appear in the index with no extra bookkeeping (`source: web`).
- No interactive approvals: whatever the permission mode + settings allowlists
  deny is auto-denied; the agent adapts.

## Data model (SQLite, better-sqlite3)

DB file: `~/Library/Application Support/orbital/index.db`. Simple versioned
migrations at server startup.

**sessions** — `id` (uuid), `project_dir`, `cwd`, `title`, `first_at`,
`last_at`, `message_count`, `file_size`, `source` (`terminal`|`web`),
`indexed_mtime`, `indexed_size`. Runtime status is NOT stored; the API merges it
from the watcher.

**tags** — `id`, `name`, `color`.

**session_tags** — `session_id`, `tag_id`, `origin`
(`rule` | `manual` | `manual_removed`). Manual wins over rules; `manual_removed`
prevents a rule from re-adding a removed tag. Rule changes regenerate all
`origin='rule'` rows and never touch manual rows.

**tag_rules** — `id`, `tag_id`, `glob` (matched against `cwd`), `priority`.

**settings** — key/value (last used permission mode, default dirs, …).

## API

REST under `/api`:

| Endpoint | Purpose |
|---|---|
| `GET /sessions?tag=&q=&source=&limit=&offset=` | history list from index; title fulltext; runtime status merged in |
| `GET /sessions/:id` | detail + metadata |
| `GET /sessions/:id/messages?before=&limit=` | paged transcript read (lazy-parsed from .jsonl) |
| `POST /sessions` | new web session `{cwd, prompt, permissionMode, model?}` → `sessionId` |
| `POST /sessions/:id/messages` | next prompt (revives via resume if needed) |
| `POST /sessions/:id/interrupt` | stop the running turn |
| `PATCH /sessions/:id` | rename title |
| `PUT /sessions/:id/tags` | manual tag changes |
| `GET/POST/PATCH/DELETE /tags`, `/tag-rules` | tag + rule CRUD; rule change → regenerate |
| `GET /projects` | known cwds for the new-session picker |

WebSocket `/ws`, topic-multiplexed:

```
client → server: {type:"subscribe"|"unsubscribe", topic:"sessions" | "session:<id>"}
server → client: {topic:"sessions",     event:"upsert"|"remove", session}
                 {topic:"session:<id>", event:"message", message}
                 {topic:"session:<id>", event:"status", status:"working"|"idle"|"ended"}
                 {topic:"session:<id>", event:"subagent", subagent:{id, name, state:"running"|"done"}}
                 {topic:"session:<id>", event:"turn_result", usage}
```

Terminal and web sessions share the same message shape; the UI only differs in
whether the prompt input is shown.

## UI

React 18 + Vite + TypeScript + Tailwind + react-three-fiber (+ drei) + zustand.

### Space map (main area)

- Flat 2D top-down scene, orthographic camera, pan + zoom only (no rotation).
  Subtle starfield/nebula background.
- Planets = sessions; loose clustering by tag/project. States:
  - active + working: pulsing glow, bright energy ring
  - active + idle: calm steady glow
  - ended/historical: dimmed, desaturated, smaller
- Moons = subagents on circular orbit trails; materialize on spawn, settle/fade
  on completion. Driven by real `subagent` WS events, not decorative.
- Tag hue shown as the planet's ring/atmosphere color.
- Visual detail (palette, typography, panel styling) comes from the Claude
  Design canvas linked above.

### Panels

- **Left sidebar** (collapsible, glass panel): search, tag filter chips,
  Active section with status dots, history by recency, source filter.
- **Detail panel** (right, opens on planet click / list click): editable title,
  cwd, tags, permission-mode badge, status, token usage; transcript view;
  prompt input + Stop for web sessions; "runs in terminal — read-only" bar for
  live terminal sessions; "Continue conversation…" input for ended sessions
  (spawns resume). Taking over a session still live in a terminal is blocked.
- **New session dialog**: cwd picker (autocomplete from `GET /projects` + free
  path), permission mode, first prompt.
- **Tag/rule management**: CRUD for tags (name + color) and rules
  (`glob → tag`, priority) with a preview of how many sessions a rule matches.

### Message rendering

One pipeline for all session kinds:

- `react-markdown` + `remark-gfm` for assistant/user text
- Shiki for code block syntax highlighting
- `anser` (ANSI → HTML) for Bash tool outputs
- Tool calls collapsed to one-line rows (`⚙ Bash: npm test`), expandable to full
  input/output

### Component reusability (binding rule for implementation)

- Variants and states are expressed through **props** (e.g.
  `<Planet state="working" tagColor=… size=…>`, `<Panel side="left|right">`,
  `<Chip variant=…>`), never by cloning a component or overriding its styles
  from the outside.
- Before creating a component, check whether an existing one covers the case
  with a new prop/variant. New component only for genuinely new semantics.
- No external style patching (`className` overrides that change a component's
  internals); components own their styling and expose intent-level props.

### Error states

- WS disconnect → banner + auto-reconnect with resubscribe
- SDK process crash → session `ended` with an error message in the chat
- Unparseable transcript lines → skipped with a warning, never a blank screen

## Testing

- Server: Vitest. Unit tests for transcript parser, indexer incremental logic,
  tag-rule engine (fixture .jsonl files copied from real transcripts,
  anonymized). Integration test for the runner against a mocked SDK.
- Web: Vitest + Testing Library for panels/list logic; the R3F scene is tested
  via its derived state (what planets/moons/states are rendered), not pixels.
- TDD per superpowers workflow.

## Open items

- Export design artboards to `docs/design/` (canvas link needs auth)
- Exact positioning algorithm for planet clusters (force layout vs. static grid
  per tag) — decide during implementation planning
