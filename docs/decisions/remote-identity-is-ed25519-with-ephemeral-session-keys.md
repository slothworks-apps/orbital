---
id: remote-identity-is-ed25519-with-ephemeral-session-keys
title: Remote identity is Ed25519, with an ephemeral session handshake per connection
status: in-force
type: adr
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - 2026-10-01-mobile-remote-backend
tags:
  - remote
  - security
  - crypto
---
# Remote identity is Ed25519, with an ephemeral session handshake per connection

## Context

The spec (§ 1, as first written) gave each device two permanent key
pairs: X25519 for key agreement and Ed25519 for signing. The X25519 pair
would do double duty as the device's long-term identity on the relay and
as the thing a session key is derived from. Building it, two problems
showed up: a static X25519 shared secret gives every session the same
key unless a counter is persisted across restarts and reconnects, and a
relay that forwards both devices' public keys is in a position to
describe a session's parameters without either side proving they agreed
to them — nothing signs the key-agreement material itself.

## Decision

One Ed25519 identity pair per device, stored once, used only to sign —
never for key agreement. Every connection runs a fresh X25519 exchange:
the initiator (the phone) generates an ephemeral key pair and signs
`CONTEXT ‖ ownEphemeral` with its identity key; the responder (the Mac)
signs `CONTEXT ‖ ownEphemeral ‖ initiatorEphemeral` — covering both
ephemerals, not just its own, so its signature cannot exist before the
initiator's half has arrived and cannot be replayed against a different
initiator. Both sides derive the shared secret from the two ephemerals,
then HKDF-SHA256 it into one AES-256-GCM key per direction. Every sealed
body carries an explicit, strictly increasing counter as its nonce;
`open()` rejects a replay and tolerates a gap. `Handshake.complete()` is
single-use — a second call is inert — so a key is never re-derived under
a nonce that could repeat. This supersedes the spec's § 1 "X25519 pair +
Ed25519 pair" (amended 2026-10-01).

## Alternatives ruled out

- **A static X25519 identity, as first specced.** Reusing it as the
  session key (or deriving one deterministically from it without an
  ephemeral) means every connection between the same two devices shares
  a key unless a counter survives restarts and reconnects — and nothing
  in the design persisted one. A fresh ephemeral exchange per connection
  sidesteps that outright: there is no counter to lose, because there is
  no key to reuse.
- **Signing only the signer's own ephemeral, both directions.** Simpler,
  but a relay sitting between two honest devices could, in principle,
  hand the initiator's ephemeral to an impersonator and let it answer
  with its own signed ephemeral — nothing ties the responder's signature
  to the specific initiator it is supposedly answering. Making the
  responder sign both ephemerals closes that: its signature is
  meaningless unless it has genuinely seen the initiator's key first.
- **WebCrypto's curve primitives**, to avoid a dependency. Curve support
  differs between Node and the engines a Capacitor WebView embeds, so the
  same code would not run identically in both places. `@noble/curves`,
  `@noble/ciphers` and `@noble/hashes` are pure JS and behave identically
  everywhere, at the cost of carrying the library.

## Consequences

- Forward secrecy per connection: compromising one session's ephemeral
  secret (which is never written anywhere) does not expose any other
  session, past or future, even between the same two devices.
- No counter to persist across restarts — the one problem that made the
  original design awkward disappears rather than getting solved.
- Once paired, a relay cannot substitute an ephemeral key: the identity
  keys never change per connection, so a substituted ephemeral would have
  to come with a valid signature under the real identity key.
- At pairing time, what binds the phone's identity key to the QR is the
  pairing proof, not the fingerprint (corrected 2026-10-01). The
  fingerprint is 30 bits — a human check, short enough that a relay could
  grind a key of its own whose fingerprint matches. The QR therefore
  carries a random `secret` the relay never sees, and the phone's redeem
  carries `proof` = HMAC-SHA256(secret, phone public key)
  (`pairingProof` in `shared/src/remote/relayApi.ts`); the Mac ignores a
  `pair_request` whose proof does not verify against the phone key it
  names. The fingerprint stays as the user's confirmation that the phone
  in hand is the one asking.
- One extra round trip's worth of signing and verifying per connection
  (cheap; Ed25519 verification is not the bottleneck anywhere in this
  path), and a second concept (identity key vs. ephemeral key) to carry
  in the code and in anyone's mental model of it.
