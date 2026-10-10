---
id: a-refused-websocket-upgrade-holds-the-server-open
title: A refused WebSocket upgrade keeps app.close() from finishing
status: backlog
type: fix
domain: server
related:
  - 2026-10-05-embedded-terminal-design
  - 2026-10-03-api-token-and-named-files-design
tags:
  - websocket
  - shutdown
---
# A refused WebSocket upgrade keeps app.close() from finishing

Found while testing the terminal socket; it applies to `/ws` the same way.

## What happens

A WebSocket upgrade the server refuses over a real connection (the token
guard's `401`, or the Origin check's `403`) leaves that connection open on the
server. `app.server.getConnections()` still counts it after the client has
destroyed its socket, and `app.close()` waits on it for good.

Reproduced on 2026-10-10 with a real `ws` client against `/ws` without a token:
the client gets `401` (with `connection: keep-alive`), destroys its socket,
and `app.close()` never resolves. A refused REST call over `fetch` does not
do it. Adding `Connection: close` to the `401` does not help.

## Why it matters

- In the packaged app a quit closes the server through `app.close()`. A page
  that tried the socket and was refused would hold that close until
  `ORPHAN_CLOSE_TIMEOUT_MS` forces the exit, and the `onClose` cleanup
  (terminals, runner, database) would not run.
- Tests cannot check a refusal over a real socket; they go through
  `app.inject` instead (`server/test/apiToken.test.ts`,
  `server/test/terminals.test.ts`).

## Where to look

The upgrade path of `@fastify/websocket`: a request refused in `onRequest` or
`preValidation` gets its response written to the raw upgrade socket, and that
socket is neither destroyed nor tracked by the idle-connection closing
Fastify does on `close()`. Destroying `req.raw.socket` after the refusal is
sent, or `forceCloseConnections: true`, are the two candidates.
