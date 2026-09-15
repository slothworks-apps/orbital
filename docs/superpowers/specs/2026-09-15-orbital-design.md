# Orbital — Design Spec

**Date:** 2026-09-15 (updated after visual design review)
**Status:** Approved pending final review
**Visual design:** `design/Orbital_ celestial agent dashboard/` (exported Claude Design canvas:
`Orbital.dc.html` = 8 artboards, `Planet Variants.dc.html`, sloth mascot assets)
Canvas source: https://claude.ai/design/p/df77470e-1384-436c-8b25-5e01acfc497f?file=Orbital.dc.html

## Overview

Orbital is a local web app that visualizes and manages Claude Code sessions as a
2D space map: sessions are planets, subagents are orbiting moons. It shows live
terminal sessions (read-only), full session history, tag-based organization, and
can spawn and drive its own sessions through the Claude Agent SDK (full chat with
the agent from the browser).

Runs only on the owner's Mac, binds to `127.0.0.1`, no authentication.

## Goals

- Overview of all Claude Code sessions: active (terminal + web) and historical
- Free-form tags (work, personal, oncall, experiments, …) with ordered auto-rules and manual overrides
- Open any historical session and continue the conversation from the web (SDK resume)
- Spawn new sessions from the web with a chosen cwd and permission mode
- Clear-and-continue flow with session lineage (web sessions)
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
├── design/          # exported Claude Design canvas (reference, committed)
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
  Idle timeout (default 30 min, configurable — "mark session ended after") →
  kill process, session shown as ended; the next prompt revives it with
  `resume: sessionId` (also how historical/ended sessions are continued).
- Interrupt: Stop → confirm dialog → SDK interrupt; partial response is
  discarded, edits already written to disk stay; session returns to needs-input.
- **Clear flow** (web sessions): "Clear only" ends the session (moves to
  history). "Clear & start new" additionally spawns a fresh session in the same
  cwd, inheriting tags and permission mode (configurable), and records lineage
  (`parent_id`). Confirm dialog is skippable via settings.
- Transcripts are written to `~/.claude/projects/` by the SDK itself, so web
  sessions appear in the index with no extra bookkeeping (`source: web`).
- No interactive approvals: whatever the permission mode + settings allowlists
  deny is auto-denied; the agent adapts.
- **Billing guard:** web sessions must use the user's Claude subscription
  (OAuth credentials from the CLI login), never per-token API billing. Because
  the CLI prefers `ANTHROPIC_API_KEY` over OAuth when both are present, the
  server deletes `ANTHROPIC_API_KEY` from its environment at boot unless
  `ORBITAL_USE_API_KEY=1` is set explicitly.

### Session status model

`working` → agent mid-turn. `needs_input` → web session finished a turn and
waits for the user (also moons/planets show white ripple per state sheet).
`idle` → live terminal session not currently working. `ended` → no live
process. Terminal sessions only use `working`/`idle`/`ended` (we cannot
reliably detect needs-input for them); web sessions use all four.

## Data model (SQLite via Drizzle ORM, better-sqlite3 driver)

DB file: `~/Library/Application Support/orbital/index.db`. Simple versioned
migrations at server startup.

**sessions** — `id` (uuid), `project_dir`, `cwd`, `title`, `first_at`,
`last_at`, `message_count`, `file_size`, `source` (`terminal`|`web`),
`permission_mode` (web sessions), `parent_id` (lineage, web sessions, nullable),
`indexed_mtime`, `indexed_size`. Runtime status is NOT stored; the API merges it
from the watcher/runner.

**tags** — `id`, `name`, `hue` (oklch hue number; color rendered as
`oklch(80% .13 <hue>)`), `is_default` (exactly one; untagged sessions fall back
to it).

**session_tags** — `session_id`, `tag_id`, `origin`
(`rule` | `manual` | `manual_removed`). Manual wins over rules; `manual_removed`
prevents a rule from re-adding a removed tag. Rule changes regenerate all
`origin='rule'` rows and never touch manual rows.

**tag_rules** — `id`, `tag_id`, `position` (order), `enabled`,
`condition` (`path_matches` | `title_contains` | `permission_is`), `pattern`.
Evaluated top → bottom, **first enabled match wins** (one auto-tag per session;
manual tags are additive on top).

**settings** — key/value: `default_permission_mode`, `default_project_dir`,
`lineage_depth` (1–5 or ∞), `confirm_before_clear` (bool), `inherit_tags`,
`inherit_permission_mode` (bools), `ended_after_idle_minutes`.

## API

REST under `/api`:

| Endpoint | Purpose |
|---|---|
| `GET /sessions?tag=&q=&source=&limit=&offset=` | history list from index; title fulltext; runtime status merged in |
| `GET /sessions/:id` | detail + metadata (incl. lineage chain) |
| `GET /sessions/:id/messages?before=&limit=` | paged transcript read (lazy-parsed from .jsonl) |
| `POST /sessions` | new web session `{cwd, prompt, permissionMode, tagId?, model?}` → `sessionId` |
| `POST /sessions/:id/messages` | next prompt (revives via resume if needed) |
| `POST /sessions/:id/interrupt` | stop the running turn |
| `POST /sessions/:id/clear` | `{startNew: bool}` → clear only / clear & start new (returns new sessionId if spawned) |
| `PATCH /sessions/:id` | rename title |
| `PUT /sessions/:id/tags` | manual tag changes |
| `GET/POST/PATCH/DELETE /tags`, `/tag-rules` | tag + rule CRUD; reorder via `position`; rule change → regenerate |
| `POST /tag-rules/preview` | `{cwd|title|permission}` → which rule matches (for the live preview row) |
| `GET /projects` | known cwds for the new-session picker |
| `GET/PATCH /settings` | app settings |

WebSocket `/ws`, topic-multiplexed:

```
client → server: {type:"subscribe"|"unsubscribe", topic:"sessions" | "session:<id>"}
server → client: {topic:"sessions",     event:"upsert"|"remove", session}
                 {topic:"session:<id>", event:"message", message}
                 {topic:"session:<id>", event:"status", status:"working"|"needs_input"|"idle"|"ended"}
                 {topic:"session:<id>", event:"subagent", subagent:{id, name, state:"materializing"|"working"|"idle"|"needs_input"|"ended"}}
                 {topic:"session:<id>", event:"turn_result", usage}
```

Terminal and web sessions share the same message shape; the UI only differs in
whether the prompt input is shown.

## UI

React 18 + Vite + TypeScript + Tailwind + react-three-fiber (+ drei) + zustand.

### Design language (from the exported canvas — binding)

- **Fonts:** Manrope (UI), JetBrains Mono (technical data: paths, counts,
  labels, statuses).
- **Background:** near-black blue space (`#05070d`–`#03111a` range), starfield,
  faint nebula tones.
- **Panels:** glass — translucent dark fill, thin luminous borders
  (`rgba(150,205,255,.08–.2)`), muted blue-grey text (`rgba(160,190,225,.5–.75)`),
  bright text `#e8eef8` / `#cfe6ff`.
- **Tag hues:** rendered as `oklch(80% .13 <hue>)` — work 210, personal 330,
  oncall 60, experiments 150 (user-editable via hue swatches).
- **State system rule:** hue always comes from the tag; state is carried by
  motion + core only (tick-ring rotation, core pulse, white ripple), so states
  stay readable across all hues.

Planet states (see state-sheet artboard 1f):
- **Working** — ticks rotate, core pulses, soft halo breathes
- **Idle** — ticks static, steady core
- **Needs input** — white expanding ring + white core + "NEEDS INPUT" badge
- **Ended** — grey ticks, no core, ~60% opacity, drawn at ~40% scale
- **Selected** — any state + slow dashed reticle and corner brackets

Moon states: working (micro tick ring spins), idle (static disc, dim core),
needs-input (white ripple), materializing (dashed shell fades in, ripple
expands), ended (grey disc, orbit trail fades).

### Space map (main area, artboard 1a)

- Flat 2D top-down scene, orthographic camera, pan + zoom only (no rotation).
- Planets clustered by tag with cluster labels (`WORK · 3`); moons on luminous
  dashed circular orbits, driven by real `subagent` WS events.
- Top-right aggregate: `2 WORKING · 3 IDLE · 4 ENDED`.
- Bottom-left readout: zoom % + camera coordinates. Bottom-right zoom controls
  (+ / − / fit).
- Bottom-center floating button **+ New session ⌘N**.
- Lineage: linked web sessions in the same project render as a small chain next
  to the newest planet; map shows last N per `lineage_depth` setting, sidebar
  history is always unlimited.
- Easter egg: tiny sloth astronaut (`design/.../assets/sloth.svg`) drifting
  slowly across the map.

### Sidebar (left, collapsible)

Orbital logo, search (`⌘K`), tag filter chips (All + tags), ACTIVE section with
status labels (WORKING/IDLE), HISTORY with relative times, footer
`N sessions · tags & rules ›`.

### Detail panel (right, artboards 1b/1c/1g)

Editable title, cwd, tag chips, permission-mode badge, status badge; token
stats row + context-usage bar (from `turn_result` usage); transcript (chat
bubbles, collapsed tool rows `⚙ Bash: npm test` with running-state and diff
stats, expandable); prompt input + Send / Stop.
- Stop → confirm dialog "Stop the running turn?" (shows what's mid-edit;
  esc cancel; partial response discarded, disk edits stay).
- Clear → confirm dialog "/clear — Clear and start a new session?" with lineage
  preview, "Don't ask again", buttons Cancel / Clear only / Clear & start new.
- Live terminal session: "runs in terminal — read-only" bar instead of input.
- Ended session: input reads "Continue conversation…" (spawns resume).
  Take-over of a session still live in a terminal is blocked.
- Close-up map view shows a SUBAGENTS panel (name + state per moon).

### New session dialog (artboard 1d)

cwd input + Browse + recent-dirs chips; permission mode cards (plan /
acceptEdits / bypassPermissions with one-line descriptions); tag row —
pre-selected by the matching auto-rule (`auto-matched by rule ~/work/**`),
overridable; first prompt textarea; footer "spawns a new planet in WORK";
Cancel / Launch session (⌘↵).

### Settings (artboard 1h)

Single settings area with sections; v1 implements **Sessions** and
**Tags & rules** only (General, Permissions, Appearance, Shortcuts are nav
placeholders deferred to later):
- Sessions: default permission mode, default project directory, lineage depth
  (1–5/∞ with chain preview), confirm-before-clear toggle, "new session
  inherits" checkboxes (tags, permission mode), "mark session ended after"
  idle threshold. Footer shows orbital + claude-code versions.

### Tags & rules (artboard 1e)

Left: tag list (name, session count, rule count, hue swatch picker, delete),
+ new tag. Right: AUTO-TAG RULES table — drag-reorder rows, condition dropdown
(path matches / title contains / permission is), pattern input, target tag,
per-rule enable toggle; caption "evaluated top → bottom, first match wins";
+ Add rule; PREVIEW row showing a sample path → matched tag + rule. Footer
note: tag hue drives the planet's atmosphere; untagged sessions fall back to
the default tag.

### Message rendering

One pipeline for all session kinds:

- `react-markdown` + `remark-gfm` for assistant/user text
- Shiki for code block syntax highlighting
- `anser` (ANSI → HTML) for Bash tool outputs
- Tool calls collapsed to one-line rows, expandable to full input/output

### Component reusability (binding rule for implementation)

- Variants and states are expressed through **props** (e.g.
  `<Planet state="working" hue={210} size=…>`, `<Panel side="left|right">`,
  `<Chip variant=…>`), never by cloning a component or overriding its styles
  from the outside.
- Before creating a component, check whether an existing one covers the case
  with a new prop/variant. New component only for genuinely new semantics.
- No external style patching (`className` overrides that change a component's
  internals); components own their styling and expose intent-level props.
- The planet/moon state system is one parametric component family (hue, state,
  scale), exactly as the state sheet implies — not per-state components.

### Error states

- WS disconnect → banner + auto-reconnect with resubscribe
- SDK process crash → session `ended` with an error message in the chat
- Unparseable transcript lines → skipped with a warning, never a blank screen

## Testing

- Server: Vitest. Unit tests for transcript parser, indexer incremental logic,
  tag-rule engine (ordered first-match-wins incl. manual overrides; fixture
  .jsonl files copied from real transcripts, anonymized). Integration test for
  the runner against a mocked SDK.
- Web: Vitest + Testing Library for panels/list logic; the R3F scene is tested
  via its derived state (what planets/moons/states are rendered), not pixels.
- TDD per superpowers workflow.

## Deferred (explicitly out of v1)

- Settings sections General / Permissions / Appearance / Shortcuts
- "New session inherits: pinned files" and "one-paragraph summary of the
  previous session as first message" (needs a summarization step)
- Interactive permission prompts (`canUseTool`)
- Needs-input detection for terminal sessions

## Open items

- Exact positioning algorithm for planet clusters (force layout vs. static grid
  per tag) — decide during implementation planning
