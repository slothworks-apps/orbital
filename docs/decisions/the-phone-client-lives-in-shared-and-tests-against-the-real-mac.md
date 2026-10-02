---
id: the-phone-client-lives-in-shared-and-tests-against-the-real-mac
title: The phone client lives in shared/ and tests against the real Mac
status: in-force
type: adr
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - 2026-09-30-mobile-remote-design
  - the-phone-tunnels-the-api-behind-an-allowlist
tags:
  - mobile
  - relay
  - testing
---
# The phone client lives in `shared/` and tests against the real Mac

**Decided 2026-10-02**, while brainstorming
[[2026-10-02-mobile-app-design]].

## Context

The phone side of the remote protocol — relay link, handshake, cipher,
request ids, blob chunks, the rules of when to handshake and when to
re-subscribe — has to exist somewhere the mobile UI can call it. The
parent spec put the mobile UI in `web/` as a second Vite entry. The
obvious place for the client was next to it, `web/src/mobile/transport/`.

`server/test/remoteFakePhone.ts` already plays a phone in the backend's
end-to-end test, with the same protocol logic written a second time,
test-shaped.

## Decision

The client is `shared/src/remote/client.ts`: a `RemoteClient` class
with the WebSocket implementation injected, no DOM, no Node-only API
(the `shared/` lint already forbids `Buffer`). The mobile entry wraps it
in two thin adapters (`tunnelFetch`, `TunnelSocket`) that carry browser
types. The client's own tests run in `server/test/` under Node with
`ws`, against the real relay and the real `buildServer` — the harness
the backend's end-to-end test already has.

The fake phone stays for tests that need a phone to misbehave (skip the
proof, send a stale nonce, open two sockets).

## Consequences

- One implementation of the phone's protocol rules, exercised by the
  same server code that will face the real phone. A change in
  `server/src/remote/` that breaks a phone breaks a server test.
- `shared/` grows a dependency on nothing new: `@noble/*` and zod are
  already there; the WebSocket comes from the caller.
- The mobile UI cannot be tested through the client in jsdom with a
  real server (jsdom has no `ws` server); that layer is tested with a
  stubbed client, which is fine because the client itself is covered
  below it.
- Ruled out: the client in `web/src/mobile/` with the fake phone kept as
  the only Node-side exercise of the protocol (two implementations,
  one of them never shipped); and importing `web/` sources from
  `server/test/` (a cross-workspace import of TS the server does not
  otherwise depend on).
