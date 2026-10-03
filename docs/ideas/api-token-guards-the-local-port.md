---
id: api-token-guards-the-local-port
title: A token should guard the local API port
status: superseded
type: idea
domain: server
related:
  - desktop-wrapper-electron
  - clickable-file-paths-in-the-transcript
  - 2026-10-03-api-token-and-named-files-design
tags:
  - security
---
# A token should guard the local API port

The server binds `127.0.0.1` with no authentication. "Localhost only"
protects less than it sounds: the user's everyday browser is also on
localhost, and it runs foreign JavaScript from every open page. Any of
that code can send requests to the port; the server cannot tell the
user's click from an ad script's fetch. The browser's same-origin
policy stops the response from being *read*, and the Host/Origin guards
in `index.ts` blunt the known way around it (DNS rebinding) — but a
single header check is a thin last line when the routes behind it read
files (`/api/files`, sandboxed to a session's cwd for exactly this
reason) and launch agent sessions.

This came up while designing the file viewer, and it does not go away
with the Electron wrapper: that spec keeps the window on
`http://127.0.0.1:4737`, so the port — and every other browser on the
machine — stays.

## The idea

A bearer token, generated per server start:

- The server mints a random secret on boot and rejects any request
  (HTTP and WS handshake) that does not carry it.
- The Electron main process spawns the server, so it knows the secret
  and hands it to its own window — nothing user-visible.
- Browser mode gets it once in the URL (the CLI that starts the server
  prints/opens `http://127.0.0.1:4737/?token=…`); the client stores it
  and sends it as a header from then on.

Layering, not replacement: the cwd sandbox on `/api/files` stays. "The
viewer reads only the session's project" is correct semantics on its
own, and layers are the point — the token protects every route, the
sandbox caps the damage if the token layer ever fails.

A unix domain socket (or Electron IPC) would remove the port entirely
and is the cleaner end state for an Electron-only world, but it forfeits
the browser mode that is today the only way Orbital runs. The token
works for both modes and is a small change.

Belongs in the Electron wrapper's build at the latest — its spec should
grow a section for it — but nothing about it waits for Electron.

Superseded by spec `2026-10-03-api-token-and-named-files-design`, which
builds the token together with reading files the session named outside its cwd.
