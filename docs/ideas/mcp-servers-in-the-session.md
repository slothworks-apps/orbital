---
id: mcp-servers-in-the-session
title: Show a session's MCP servers, and let them be toggled
status: active
type: idea
domain: sessions
related:
  - subagent-model
tags:
  - detail-panel
---
# Show a session's MCP servers, and let them be toggled

MCP servers already work in Orbital sessions — the Runner passes
`settingSources: ['user', 'project', 'local']`, so the CLI under
Orbital loads the same MCP configuration a terminal session would
(user `~/.claude.json`, project `.mcp.json`, local settings). The UI
just knows nothing about them: a session using six servers and a
session using none look identical, and a server that failed to connect
fails silently from Orbital's point of view.

## What the SDK offers (verified in sdk.d.ts)

- The `system/init` message the Runner already consumes carries
  `mcpServers: McpServerStatus[]` — name and connection state, free.
- `query.mcpServerStatus()` — the live list on demand.
- `query.setMcpServers(servers)` — replace the running session's
  server set mid-flight, no restart.
- `options.mcpServers` + `strictMcpConfig` — explicit per-session
  server injection, ignoring the settings-derived ones.

## Three layers, in order of worth

1. **Visibility.** The detail panel shows the session's servers with
   their status, read from the init message (plus a re-fetch on
   demand). Nearly free, and it explains today's mysteries ("why does
   this session not see DesignSync?").
2. **Per-session toggle.** Enable/disable a server for one running
   session via `setMcpServers` — runtime-only, nothing persisted,
   parity with what the session itself could do. Needs a decided
   answer for what "disabled" means on revive.
3. **Configuration management.** Editing `.mcp.json` /
   `~/.claude.json` from Orbital. The riskiest layer — Orbital would
   be writing files the CLI owns, with its own trust flow — and the
   least necessary; possibly never worth it.

The catalog route from the composer feature is precedent for "server
reads CLI-owned config read-only"; layer 3 would be the first write,
which is a different conversation.
