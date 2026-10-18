---
id: the-group-has-one-primary-device
title: The group has one primary device, which alone adds and removes members
status: in-force
type: adr
domain: remote
related:
  - roster-entries-are-signed
  - joining-one-member-joins-the-group
  - 2026-10-16-device-group-design
  - transfer-the-primary-role
tags:
  - remote
  - security
---
# The group has one primary device

## Context

The roster was every member's to write: any member added and removed
devices, and members merged what they heard
([[joining-one-member-joins-the-group]], [[roster-entries-are-signed]]).
Signing every write stopped forgery, but not a member holding its own key
— a stolen, unlocked phone or a modified Mac — and above all not a removed
device that still reaches a member asleep at its removal. Four rounds of
adversarial review (2026-10-18) found a new way back in after each fix:
removals signed after the signer's own removal, a removed device removing
its remover, chains of adds that start at a removed key, a roster filled
for good, honest members that disagree for ever. Each fix added an
exception to a rule nobody could predict without running it. All of it
comes from one source: many writers, merged without an order.

## Decision

One device of the group is its **primary**, and only the primary writes
the membership.

- **Who.** The device that founded the group: the one showing the code at
  the first pairing — or, when that is a phone, the device that typed its
  code. A phone is never primary; a group starts on a desktop or a
  server.
- **The roster is one document** the primary signs: the group's id (the
  primary's id), a version that only grows, and every member with its
  `kind` (as the ceremony proved it). A member takes a roster only when it
  is signed by its group's primary and its version is higher than the one
  it holds — from whichever device passes it on. Nothing is merged.
- **Descriptions** (name, os, links) are signed by each device itself and
  travel beside the roster; the primary describes a device that never
  describes itself (a shipped phone). Nobody else's description is taken.
- **Joining** is a ceremony with the primary: only the primary shows or
  redeems a code that adds a device. A member that is not primary offers
  no "add a device"; a device alone may still pair with the primary either
  way round.
- **Removing** a device is the primary's: it signs a new version without
  that device. Members revoke their pairs with whoever the new version no
  longer names.
- **Leaving.** A member signs its own "left at version n"; every member
  honours it until a later version names that device again. The primary
  leaving dissolves the group: it signs a last version that names nobody,
  and every member becomes a group of one.
- **Losing the primary.** Any member can leave and found a new group, of
  which it is the primary. Handing the role over while the primary is
  alive is not built yet ([[transfer-the-primary-role]]).

## Ruled out

- **Every member writes, signed, with a merge rule**
  ([[roster-entries-are-signed]], superseded): see Context.
- **Joining through any member, signed by the primary later.** Keeps a
  newcomer half in the group while the primary sleeps; the person adds
  a device at the primary instead (decided 2026-10-18).
- **A quorum of members** signing each change. Needs most devices awake
  for every change, and a group of two has no majority.

## Consequences

- A stolen non-primary device can act as itself until the primary removes
  it, and nothing more: it cannot add, remove, or rewrite another device.
- A removed device has nothing to sign with. A member asleep at the
  removal still links with it until a newer version reaches it — from any
  member, since the version cannot be forged.
- A stolen, unlocked primary controls the group. That is the device's own
  security, like the rest of the Mac's data.
- No tombstones: a removed device is simply absent from the newer
  version, so the roster holds only the live members.
- Adding a device needs the primary awake and at hand.
