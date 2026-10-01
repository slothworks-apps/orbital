---
id: the-mcp-toggle-is-project-wide
title: The MCP server toggle is project-wide and persistent, not runtime-only
status: draft
type: adr
domain: sessions
related:
  - 2026-10-01-mcp-servers-in-the-session-design
  - mcp-servers-in-the-session
tags:
  - mcp
  - runner
---
# The MCP server toggle is project-wide and persistent

## Context

The idea `mcp-servers-in-the-session` wanted a per-session, runtime-only
toggle through `query.setMcpServers()`. The SDK's own documentation of
that method rules it out: it replaces only the servers added through the
SDK, and leaves the servers from settings files (`~/.claude.json`,
`.mcp.json`) and from plugins alone. Those are the servers the user
actually has.

What does reach them is `query.toggleMcpServer(name, enabled)`. In the
CLI it runs the same code as `/mcp disable`, which writes the name into
`disabledMcpServers` in the project's entry of `~/.claude.json`. So the
change holds for every session in that project, terminal sessions
included, and survives restarts.

## Decision

Orbital offers the toggle anyway, through `toggleMcpServer`, and says
what it does: the control states that the change applies to the whole
project and lasts until the server is switched back on.

## Rejected

- **Runtime-only toggle via `setMcpServers`** — does not reach settings
  servers.
- **Toggle, then switch back when the session ends** — races other
  sessions in the same project and leaves the config wrong if Orbital
  dies first.
- **Orbital writes the config itself** — the idea's layer 3. The CLI
  already owns this write and its format; Orbital asking the CLI to make
  it keeps one writer.

## Consequences

Turning a server off in Orbital turns it off in the terminal too. Orbital
never toggles its own server (`ORBITAL_MCP_SERVER`).
