---
id: mcpjson-decisions-in-the-mcp-dialog
title: Change a remembered .mcp.json answer from the session's MCP dialog
status: backlog
type: idea
domain: sessions
related:
  - 2026-10-08-mcpjson-approval-design
  - 2026-10-01-mcp-servers-in-the-session-design
tags:
  - mcp
---
# Change a remembered .mcp.json answer from the MCP dialog

[[2026-10-08-mcpjson-approval-design]] asks about a project's `.mcp.json`
servers before a new session starts and remembers the answer. Changing that
answer later is left out: a server that was turned down never reaches the
SDK, so the session's MCP dialog, which lists what the SDK reports, does not
show it at all. Today the only way back is `claude mcp
reset-project-choices` in a terminal, which clears every answer for the
project.

## The idea

The MCP dialog lists the project's `.mcp.json` servers that were turned
down (and those kept out as undecided), each with its command, and a switch.
Switching one on records the approval (and its fingerprint) in
`.claude/settings.local.json` and restarts the session with `resume`, since
a server kept out at start cannot join a running session. Switching an
allowed one off records the refusal.

The canvas `Feature - MCP approval.dc.html` (47e, "Not allowed") already
promises this; the MCP dialog needs its own artboard for the rows.

## Phone

The phone has no MCP dialog yet, so this would be desktop only at first.
