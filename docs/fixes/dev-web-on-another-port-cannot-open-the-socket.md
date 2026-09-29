---
id: dev-web-on-another-port-cannot-open-the-socket
title: The dev web app on any port but 5173 cannot open the socket
type: fix
status: done
domain: server
related:
  - dogfood-and-dev-side-by-side
tags:
  - dev
  - websocket
---
# The dev web app on any port but 5173 cannot open the socket

## What happens

`npm run dev` starts vite on 5173, or on the next free port when another
project already holds 5173 — vite does not pin it. The page then loads, its
REST calls work through vite's proxy, and every `/ws` handshake is refused
with 403. The map shows `reconnecting…` for good, and nothing live arrives:
no status changes, no streamed text, no task output.

Seen 2026-09-29: another project's vite held 5173, Orbital's dev web came up
on 5174, and the server answered `origin not allowed`.

## Why

`isAllowedWsOrigin` in `server/src/index.ts` — the cross-site WebSocket
hijacking guard — allows the server's own port and exactly `5173`. The
browser sends the page's origin, `http://localhost:5174`, through the proxy.

## Ways to fix it

- Pin the dev port (`server.strictPort: true` in `web/vite.config.ts`), so
  a taken 5173 fails loudly at start instead of quietly at the socket.
- Or let the dev server name its web origin (an env var `npm run dev` sets
  for both halves) and allow that one, rather than a hard-coded 5173.

Either keeps the guard as strict as it is now.

## Fixed 2026-09-29

Both suggestions, with a port of Orbital's own. `npm run dev` serves the web
app on `DEV_WEB_PORT` (4839, next to the dev server's 4838), vite pins it
with `strictPort`, and the server's origin guard and the desktop window
follow the same port. 5173 is left to other projects, whose dev servers
keep their browser storage there.
