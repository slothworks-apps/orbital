---
id: the-relay-pairs-two-devices-that-both-sign
title: The relay pairs two devices when both sign for it
status: draft
type: adr
domain: remote
related:
  - 2026-10-16-device-group-design
  - joining-one-member-joins-the-group
  - the-relay-takes-a-shared-secret
tags:
  - relay
  - security
---
# The relay pairs two devices when both sign for it

## Context

Once the roster lists a device, every member needs a relay pair with it
([[2026-10-16-device-group-design]] § 4). The relay creates a pair only
through a pairing token: one device mints it, the other redeems it while
the first is online. Members that have never met have no way to hand a
token to each other except through a third member, and the minting side
has to be online when the other redeems.

## Decision

A new relay route, `POST /pair/mutual`, signed like every pairing route,
names the other device. The relay keeps the half and creates the pair
when the other device has sent its own half naming the first. A half
waits at most `MUTUAL_PAIR_TTL`. Both members know each other's key from
the roster, which came over an authenticated channel, so the channel's
handshake proves that neither half came from the relay.

## Ruled out

- **Tokens passed through a common member.** No relay change, but the
  token's owner has to be online when it is redeemed, and a third device
  takes part in every link.

## Consequences

- A relay minor release. A self-hosted relay that has not been updated
  still serves the group; the members it cannot link show "pair by hand".
- The relay learns that two keys want a pair, which it learns anyway once
  they are paired.
