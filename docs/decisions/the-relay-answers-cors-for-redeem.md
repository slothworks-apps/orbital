---
id: the-relay-answers-cors-for-redeem
title: The relay answers CORS for /pair/redeem
status: in-force
type: adr
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - 2026-10-02-mobile-app-read
  - run-the-relay
tags:
  - relay
  - mobile
  - security
---
# The relay answers CORS for `/pair/redeem`

**Decided 2026-10-02**, while planning [[2026-10-02-mobile-app-read]].

## Context

The phone redeems a pairing code with a signed `POST /pair/redeem`
([[2026-10-02-mobile-app-design]] § 2). The app is a WebView whose page
origin is `https://localhost` (Capacitor's Android scheme) — and, while its
layout is worked on, a desktop browser on `http://localhost:4841`. The relay
is another origin. A cross-origin JSON POST needs a CORS preflight, and the
relay answered none, so every redeem would fail as a network error before
reaching the route.

## Decision

The relay answers `OPTIONS /pair/redeem` with `access-control-allow-origin: *`,
`POST` and `content-type`, and puts `access-control-allow-origin: *` on every
`/pair/redeem` answer, refusals included, so the phone can tell an expired
code from an unreachable relay. Nothing else gets CORS: `/pair/token`,
`/pair/confirm` and `/pair/revoke` are the Mac's, and the Mac is a Node
process, not a browser.

## Consequences

- Any web page can now send a redeem, and gains nothing by it: the request
  must be signed by the key it names, the token is single-use and expires,
  the Mac checks the pairing proof that only the QR's scanner can make, and
  no cookie or ambient credential is involved.
- A deployed relay has to be redeployed before a phone can pair through it.
- Ruled out: Capacitor's native HTTP (`CapacitorHttp`), which escapes CORS
  on a device but not in the desktop browser the spec relies on for layout
  work and the fidelity pass; and a redeem message over the relay's
  WebSocket, which would change the relay protocol for one request.
