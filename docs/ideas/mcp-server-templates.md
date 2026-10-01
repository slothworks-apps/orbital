---
id: mcp-server-templates
title: MCP server templates — a shape without values that each user fills in
status: backlog
type: idea
domain: sessions
related:
  - mcp-config-is-written-by-the-cli-in-private-scopes
  - 2026-10-01-mcp-servers-in-the-session-design
tags:
  - mcp
---
# MCP server templates

A project's MCP servers are each person's own (adr
`mcp-config-is-written-by-the-cli-in-private-scopes`), so `.mcp.json`
belongs in `.gitignore`. What a team can still share is the shape: which
servers the project expects, their transport, command or URL, and which
env vars or headers they need — without the values.

A template file in the repo could list that. The MCP dialog would offer
each template entry the user does not have yet as "add from template":
the form opens prefilled, the user fills in the blanks and saves it to
`local` or `user`, or leaves it.

Open: the file's name and format, and whether it should mirror
`.mcp.json` with placeholders so it stays readable without Orbital.
