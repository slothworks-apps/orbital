---
id: joining-one-member-joins-the-group
title: Pairing with one member joins the whole group, and a removal wins
status: in-force
type: adr
domain: remote
related:
  - the-group-has-one-primary-device
  - 2026-10-16-device-group-design
  - the-relay-pairs-two-devices-that-both-sign
tags:
  - remote
  - security
---
# Pairing with one member joins the whole group, and a removal wins

> Amended on 2026-10-18 by [[the-group-has-one-primary-device]]: the one
> ceremony is with the group's primary, which alone writes the roster and
> removes devices. Joining once still joins the whole group.

## Context

Every device of a group links with every other
([[2026-10-16-device-group-design]]). Four devices are six pairs. All of
them belong to one person.

## Decision

A device joins by one ceremony with any member: a code or QR, and the
6-character code typed back, as a phone pairs today. That member writes
it into the group's roster and the others accept it from the roster
without asking again. Every member shows who added it.

The roster is kept by every member and merged: per device the higher
epoch wins, and within one epoch a removal wins. A device can be removed
from any member; it comes back only through a new ceremony, which starts
the next epoch. A device already in a group of two or more cannot join a
device of another group; it leaves its group first. A ceremony between
two members of the same group (pairing by hand, on a relay that cannot
pair them) is not refused. One person's devices form one group,
and merging two at a ceremony would surprise more than it helps: the
devices of one side would suddenly link with every device of the other.

## Ruled out

- **A ceremony per pair.** Six ceremonies for four devices, and the
  person consents to the same thing every time.
- **Confirming every introduction on every member.** The person already
  confirmed on two of their own devices; the rest would be dialogs to
  dismiss, and a server would wait on a terminal nobody watches.
- **Merging two groups at a ceremony.** Each side consented on one
  device, but the merge reaches every device of both; leaving first
  makes the move explicit (decided 2026-10-17).
- **The roster in the relay.** The relay would hold membership, which it
  does not need to route frames, and would have to change its pairing
  model.

## Consequences

- One compromised member can add a device to the group. Every member
  shows each addition, and any member can remove it.
- A member offline for weeks cannot bring a removed device back: its
  stale entry loses to the removal.
