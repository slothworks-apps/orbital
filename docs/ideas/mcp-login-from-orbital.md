---
id: mcp-login-from-orbital
title: Log in to an MCP server that needs auth, from Orbital
status: done
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

## What the SDK offers

The query object has `mcpAuthenticate(serverName, redirectUri?)`,
`mcpSubmitOAuthCallbackUrl(serverName, callbackUrl)` and
`mcpClearAuth(serverName)`. They are in the SDK's bundle but not in
`sdk.d.ts` — undocumented, so liable to change with a CLI update.

## Spike, 2026-10-01 (SDK 0.3.278)

A throwaway session, `mcpAuthenticate('plugin:cloudflare:cloudflare-api')`
with no `redirectUri`. It answered in ~150 ms with:

```json
{ "authUrl": "https://mcp.cloudflare.com/authorize?…&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback&…",
  "requiresUserAction": true, "callbackExpected": true,
  "redirectScheme": "localhost", "state": "…", "callbackPort": 3118 }
```

and the session's `claude` process was listening on `127.0.0.1:3118`.
So the CLI runs the OAuth callback itself: Orbital only has to open
`authUrl` in the browser. The status stays `needs-auth` until the user
finishes in the browser. The flow was not completed (no one logged in),
so what the status does after the callback — `connected` on its own, or
only after `reconnectMcpServer` — is still unverified.

`mcpSubmitOAuthCallbackUrl` is for a redirect the CLI cannot catch
itself (`redirectScheme` other than `localhost`); not needed for this
case.

## Built

Built the same day as specified in
`2026-10-01-mcp-servers-in-the-session-design` § Log in. Still unverified:
what the row does after a real login completes.

## Shape of the feature

- A **Log in** button on a `needs-auth` row (not on `claudeai` rows —
  those are logged in on claude.ai, so the row links there instead).
- Server: `POST /api/sessions/:id/mcp/:name/login` → `{ authUrl }`.
- Web: opens `authUrl` (`window.open`; in the desktop app the main
  process already hands external URLs to the system browser), then polls
  the list while the row says "waiting for the browser…", and calls
  reconnect once if it is still `needs-auth` after the user returns.
- If the response has `callbackExpected: false` or a non-`localhost`
  `redirectScheme`, fall back to the note.
