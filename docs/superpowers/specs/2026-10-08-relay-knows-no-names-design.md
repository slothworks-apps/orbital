---
id: 2026-10-08-relay-knows-no-names-design
title: The relay and the push services see no device names
status: active
type: spec
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - 2026-10-06-pairing-code-and-app-lock-design
  - 2026-10-07-version-compatibility-design
  - remote-identity-is-ed25519-with-ephemeral-session-keys
  - encrypted-push-payloads
  - 2026-10-08-release-roadmap
tags:
  - relay
  - push
  - privacy
  - mobile
---
# The relay and the push services see no device names

## Problem

The relay is meant to see only encrypted frames
([[2026-09-30-mobile-remote-design]]). Device names break that:

- **Push.** `pushText` in `relay/src/push.ts` titles every push
  `Orbital · <Mac name>`, so the Mac's name crosses the relay and FCM (and,
  on iOS, APNs) in the clear.
- **Storage.** The relay keeps the Mac's name (sent with `/pair/token`) and
  the phone's name and platform (sent with `/pair/redeem`) in plain text,
  with no expiry (`devices.name`, `devices.platform`,
  `pairing_tokens.phone_name`, `pairing_tokens.phone_platform`).

Session titles and message text never reach the relay; a push carries only
a count derived from `wake` tokens (`server/src/remote/wake.ts`). The names
are the leak.

## What the names are used for

- **The Mac's name, to the phone:** returned in the `/pair/redeem` answer
  and the `paired` control. The phone already has it — it is in the QR
  (`QrPayload.name`) and in the Mac's `hello` over the encrypted tunnel.
- **The phone's name and platform, to the Mac:** forwarded in
  `pair_request` so the Mac's confirmation shows "Pixel 8 · Android 15"
  (canvas 9o). There is no tunnel yet at that point, but the phone and the
  Mac share the QR's `secret` (`PAIRING_SECRET_BYTES`, fresh for every
  code), which never reaches the relay.
- **The push title.** A phone is paired with one Mac, so the name tells the
  user nothing they do not know.

## Behaviour

1. **Push text without a name.** Title `Orbital`; body "A session needs
   your input" / "N sessions need your input", as today. Nothing else in
   the FCM message changes.
2. **The Mac sends the relay no name.** `/pair/token` carries no `name`.
   The relay's `redeem` answer and `paired` control carry none either; the
   phone shows the name from the QR, and later from `hello`.
3. **The phone's name and platform reach the Mac sealed.** `/pair/redeem`
   carries `device`: `{ name, platform }` encrypted with XChaCha20-Poly1305
   under a key derived from the QR's `secret` (HKDF-SHA256, its own info
   string), with the phone's public key as associated data, so a sealed
   blob cannot be replayed for another key. The relay holds the blob, opaque
   and bounded in size, only while the request is pending, forwards it in
   `pair_request`, and deletes it on confirm, reject or expiry. The Mac
   opens it with the `secret` it minted; a blob that does not open shows the
   device as "Unknown phone" — it never blocks pairing, the code typed on
   the Mac ([[2026-10-06-pairing-code-and-app-lock-design]]) is what
   authenticates.
4. **The relay stores no names.** A migration drops the name and platform
   columns from `devices` and `pairing_tokens` (or, if the store layer makes
   dropping awkward, clears them and stops writing them). What remains per
   device is its public key, kind, push token and last seen.

## Compatibility

- The relay accepts a `/pair/redeem` from a phone that predates this —
  plain `name`/`platform`, no `device` — but stores and forwards neither;
  that Mac shows "Unknown phone". It accepts `/pair/token` with a `name` and
  ignores it.
- A Mac that predates this reads `pair_request` with no plain `name`; it
  shows an empty name. A phone that predates this shows the QR's name after
  pairing.
- New phones and Macs need the new relay to send `device`; the minimum relay
  version they ask for rises to it
  ([[2026-10-07-version-compatibility-design]]).
- The relay is a minor bump (a new field, data dropped); the phone and the
  desktop take the change with the phase 0 bump.

## Not now

Encrypted push payloads, so a push can name the session that waits, are
[[encrypted-push-payloads]]. Their visible fallback text would be rule 1's.

## Phone

Built for the phone: it seals its name and platform on redeem, and stops
reading names from the relay.

## Testing

- `shared/`: sealing and opening the device blob — round trip, wrong
  secret, wrong phone key, tampered blob, oversize.
- Relay: `/pair/redeem` with `device` stores and forwards only the blob and
  deletes it on confirm, reject and expiry; an old-style redeem forwards no
  name; `/pair/token` ignores a name; the migration leaves no name columns
  (or no names) behind; `pushText` has no name in it.
- Mac: `pair_request` with a sealed device shows its name; one that does
  not open shows "Unknown phone".
