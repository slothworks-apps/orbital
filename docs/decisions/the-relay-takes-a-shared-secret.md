---
id: the-relay-takes-a-shared-secret
title: The relay takes a shared secret, and the QR carries it to the phone
status: in-force
type: adr
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - 2026-10-01-settings-mobile-design
  - 2026-10-02-mobile-app-design
  - run-the-relay
tags:
  - relay
  - mobile
  - security
---
# The relay takes a shared secret, and the QR carries it to the phone

**Decided 2026-10-03**, before the first deployment of the relay.

## Context

The relay authenticates every device by a signed challenge, which proves the
device owns its Ed25519 key — not that the key belongs on this relay. Anyone
who knows the relay's URL can connect, mint pairing tokens as a Mac, redeem
them as a phone, and run their own Mac–phone pair over it: their frames are
forwarded, their rows are stored, and their pushes go out through the
operator's Firebase project. The content stays unreadable (the end-to-end
encryption does not depend on the relay), so the harm is use of the
operator's relay and push quota by strangers, not disclosure.

Three ways to close the door were weighed:

- **A shared secret** the relay reads from its environment and every device
  presents when it connects and when it pairs. Operationally a password:
  set once in the deployment, typed once on the Mac.
- **An allowlist of Mac keys** in the relay's environment: only listed Macs
  mint tokens and connect, phones only through a pair with one. Stronger
  (nothing to leak) but every new Mac is a redeploy.
- **Nothing**, the URL being the only protection, with security revisited
  once adoption warrants it.

## Decision

A shared secret, optional. `RELAY_SECRET` in the relay's environment; unset
means the relay is open, as before (local development, the test harness).
When set, the relay requires it on every WebSocket authentication and in
every pairing route, from Macs and phones alike; a mismatch closes the
socket with a dedicated code and answers the route with 401 `bad_secret`.

The Mac keeps it in a setting (`remote_relay_secret`, Settings → Mobile →
ADVANCED, next to the relay URL) and sends it with everything it signs. The
phone never types it: the pairing QR already carries the relay URL and a
one-time pairing secret, and now carries the relay secret too; the phone
stores it with the pairing and sends it on every connect. Pairing stays
"scan a code, confirm on the Mac" with nothing else to fill in.

Rotation is re-pairing: a changed secret (on the relay, then in the Mac's
setting) stops every phone from connecting; each phone treats the refusal
as its pair being gone and lands on the unpaired screen, the Mac forgets
its phones when the setting changes (locally — its own link was refused,
so the revoke does not reach the relay, which keeps a dead pair row and a
dead push token, both harmless), and a fresh scan carries the new secret.

The allowlist was set aside, not rejected: it can sit beside the secret
later, for an operator who wants a Mac to need the operator's hand.

## Consequences

- Fields, all optional for wire compatibility: `secret` on the signed
  request envelope and on the WebSocket `auth` message, `relaySecret` in
  the QR payload. A phone or Mac built before this sends none and still
  works against an open relay.
- The relay compares in constant time and never logs the secret.
- A Mac whose secret the relay refuses stops reconnecting and reports it
  under Settings → Mobile ("couldn't start" with the reason); a phone whose
  secret is refused treats it as its pair being gone (9h).
- The Settings → Mobile canvas (9m, 9r) draws only the relay URL; the
  secret row mirrors it until the canvas catches up.
