---
id: mcp-login-from-orbital
title: Log in to an MCP server that needs auth, from Orbital
status: backlog
type: idea
domain: sessions
related:
  - 2026-10-01-mcp-servers-in-the-session-design
tags:
  - mcp
---
# Log in to an MCP server from Orbital

The MCP dialog shows a `needs-auth` server but cannot log in to it, so
the user still needs a terminal (`/mcp`) for that one step.

The SDK's query object has `mcpAuthenticate(serverName, redirectUri)`,
`mcpSubmitOAuthCallbackUrl` and `mcpClearAuth` in its bundle, but
`sdk.d.ts` does not declare them — undocumented, so liable to change.
Worth a spike: does `mcpAuthenticate` return a URL Orbital can open in
the browser, and does the CLI complete the flow on its own callback, or
must Orbital relay the callback URL?

claude.ai connectors are logged in on claude.ai, not here.
