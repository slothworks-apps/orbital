---
id: server-dies-on-an-unhandled-socket-econnreset
title: The server process dies on an unhandled ECONNRESET from a socket
status: backlog
type: fix
domain: server
tags:
  - server
  - robustness
---
# The server process dies on an unhandled ECONNRESET from a socket

## What happens

A dev server (`npm run dev -w server`, built web served through
`ORBITAL_STATIC_DIR`) exited while a Playwright browser navigated from one
Orbital page to another server's page on the same host. The log ended with:

```
Error: read ECONNRESET
    at TCP.onStreamRead (node:internal/stream_base_commons:216:20)
Emitted 'error' event on Socket instance at:
    at emitErrorNT (node:internal/streams/destroy:170:8)
```

So a `net.Socket` emitted `error` with no listener, and Node turned it
into an uncaught exception. Seen once, on 2026-10-29. Not reproduced on
purpose yet.

## Where to look

Every socket the server owns or hands around: the WebSocket upgrade path
(`/ws`), any proxying or piping of a request or response stream, and the
relay connection. A socket that is used outside Fastify's own request
handling needs its own `error` listener.

## Why it matters

The desktop app forks this server. A peer resetting a connection, which is
normal (a closed tab, a phone dropping off Wi-Fi), should not take every
session view down with it.
