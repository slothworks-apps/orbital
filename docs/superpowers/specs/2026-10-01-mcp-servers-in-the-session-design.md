---
id: 2026-10-01-mcp-servers-in-the-session-design
title: MCP servers in the session — status, reconnect and a project-wide toggle in the detail panel
status: draft
type: spec
domain: sessions
related:
  - mcp-servers-in-the-session
  - the-mcp-toggle-is-project-wide
tags:
  - server
  - runner
  - detail-panel
  - mcp
---
# MCP servers in the session

## Problem

An Orbital session loads the same MCP servers a terminal session would
(the Runner passes `settingSources: ['user', 'project', 'local']`), but
Orbital shows nothing about them. A session with six servers and one
with none look the same, and a server that failed to connect fails
silently — the user finds out only when the model says a tool is
missing.

## What the user gets

For a **running Orbital session**, the detail panel lists the session's
MCP servers. Each row carries:

- the server's name;
- its status — connected, failed, needs login, starting, off (the SDK's
  `connected | failed | needs-auth | pending | disabled`);
- the error message, when the status is failed;
- where the server comes from — the SDK's `source`, falling back to
  `scope` on a CLI that predates `source` (user, project, local, plugin,
  claudeai, managed …);
- how many tools it offers, when connected.

Actions per row:

- **Reconnect** — on a server that is `failed`. Calls
  `reconnectMcpServer(name)`.
- **On/off switch** — on every server except Orbital's own
  (`ORBITAL_MCP_SERVER`, `source: 'sdk'`). Calls
  `toggleMcpServer(name, enabled)`. The control says, before it is used,
  that the change applies to the whole project — terminal sessions
  included — and lasts until the server is switched back on. See
  adr `the-mcp-toggle-is-project-wide`.

A `needs-auth` server gets a note, not an action: log in through `/mcp`
in a terminal session. Orbital does not run the MCP OAuth flow.

## What it does not do

- **Terminal sessions** show nothing. Orbital has no control channel to
  them; features may be Orbital-only on purpose.
- **An Orbital session without a running process** (asleep, ended)
  shows nothing either. The list is a reading of a live process; a stale
  copy would be wrong exactly when it matters (a server that has since
  been fixed).
- **No configuration editing** — layer 3 of the idea. Orbital does not
  write `.mcp.json` or `~/.claude.json` itself; the toggle's write is the
  CLI's own, the same one `/mcp disable` makes.

## Server

### Runner

`QueryFn` and the per-session `generator` type gain three optional
methods, optional for the same reason as the others (a fake in a test, an
old CLI): `mcpServerStatus`, `reconnectMcpServer`, `toggleMcpServer`.

The `system/init` handler keeps `msg.mcpServers` on the session state as
the session's last known list.

New Runner methods, each throwing `session … is not active` for a
session it does not run, like `setModel`:

- `mcpServers(sessionId)` — asks `mcpServerStatus()`; when the CLI does
  not answer it (method missing, or the call throws), returns the init
  snapshot. Returns `McpServerRow[]` (below), never the SDK's raw object.
- `reconnectMcpServer(sessionId, name)` and
  `toggleMcpServer(sessionId, name, enabled)` — pass through; a missing
  method on the generator is an error ("this CLI cannot …"), not a
  silent no-op. Toggling `ORBITAL_MCP_SERVER` is refused in the Runner,
  not only hidden in the UI.

The CLI announces no status change on its own — there is no system
message for it — so the list is pulled, never pushed.

### Row shape

```ts
type McpServerRow = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error?: string;
  origin?: string;      // source ?? scope
  toolCount?: number;   // tools.length, when present
  toggleable: boolean;  // false for ORBITAL_MCP_SERVER
};
```

An unknown status string from a newer CLI passes through as is and the
UI shows it as text. Names and errors are untrusted text from config
files; React escapes them, nothing renders them as HTML.

### Routes

- `GET /api/sessions/:id/mcp` → `{ servers: McpServerRow[] }`.
- `POST /api/sessions/:id/mcp/:name/reconnect` → `{ servers }`, the list
  read again after the call.
- `POST /api/sessions/:id/mcp/:name/enabled` with body
  `{ enabled: boolean }` → `{ servers }`.

Unknown session → 404. Session not running → 409. A body without a
boolean `enabled` → 400. A name the session's list does not contain →
404. A CLI that refuses → 502 with its message.

## Web

`api.mcpServers(id)`, `api.reconnectMcpServer(id, name)`,
`api.setMcpServerEnabled(id, name, enabled)`.

The list loads when the user opens it and is replaced by every action's
response. While any row is `pending`, it is fetched again on a short
interval, and only while it is open. A failed fetch shows the error in
place of the list.

Where the list lives in the panel and how it looks is decided in Claude
Design, not here.

## Testing

- Runner: init snapshot kept; `mcpServers` prefers the live answer and
  falls back to the snapshot; inactive session throws; missing toggle
  method throws; toggling `ORBITAL_MCP_SERVER` refused.
- Routes: 404 / 409 / 400 / unknown name, and the happy path of each.
- No UI tests.

## First step of the implementation

Confirm, with a throwaway session, that `toggleMcpServer(name, false)`
writes `disabledMcpServers` into the project's entry in
`~/.claude.json`. The binary's code points that way, but it was not run.
If the write does not happen, the toggle is runtime-only and the warning
text in the UI and the adr change accordingly.
