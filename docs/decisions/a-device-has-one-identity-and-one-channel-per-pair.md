---
id: a-device-has-one-identity-and-one-channel-per-pair
title: A device has one identity, and one channel per pair carries both directions
status: in-force
type: adr
domain: remote
related:
  - 2026-10-16-device-group-design
  - remote-identity-is-ed25519-with-ephemeral-session-keys
tags:
  - remote
  - relay
  - security
---
# A device has one identity, and one channel per pair carries both directions

## Context

Every device of a group talks to every other directly, in both
directions ([[2026-10-16-device-group-design]]). Until now a pair had a
fixed shape: a Mac serves, a phone asks. PR #79 made a Mac ask another
Mac by registering a second identity with the relay as a phone, one per
Mac it asks. The relay already allows more than that: it routes a frame
between any two devices it holds a pair for, in either direction, and
its `mac`/`phone` kinds only say who minted a pairing token and who
redeemed it. What it does not allow is two sockets for one device.

## Decision

A device is one Ed25519 key: the host identity a Mac or a server already
has, the identity the phone already has. It holds one socket to the
relay. Between two members there is one channel, set up by the existing
handshake (the lower device id initiates; a phone that does not know
groups always does), and both sides serve and ask over it: requests,
topics, blobs and files flow either way.

## Ruled out

- **A key per role (#79).** A device becomes a set of keys. Introducing
  it to the group, removing it and showing who it is all have to map keys
  back to devices, and the phone keeps one identity per Mac.
- **A socket per link.** The relay replaces a device's socket when the
  same key connects again, so a socket per link needs a key per link,
  which is the case above.

## Consequences

- The phone and the Mac keep their keys, so pairings made before groups
  stay valid.
- `PhoneSession` (serving) and `RemoteClient` (asking) become the two
  halves of one channel type, used on every device.
- The relay does not change for this.
