---
id: roster-entries-are-signed
title: Roster entries are signed — a device describes itself, a member adds and removes
status: in-force
type: adr
domain: remote
related:
  - joining-one-member-joins-the-group
  - 2026-10-16-device-group-design
  - every-member-reaches-one-literal-allowlist
tags:
  - remote
  - security
---
# Roster entries are signed

## Context

The roster ([[joining-one-member-joins-the-group]]) travels between members
and is passed on by members that did not write it: an entry for device D
reaches C through B. Until now no entry was signed, and a member took an
entry from any member that sent it, guarded only by rules on the epoch
(`admitted` in `shared/src/remote/roster.ts`). An adversarial review of PR
#97 (2026-10-18) showed what that leaves open to one member holding a key —
a stolen phone or a modified Mac:

- it rewrites its own `kind` and `links` and is treated as a desktop: other
  members federate its sessions and other phones link with it;
- it rewrites another member's description (`kind: 'phone'`, a later
  `describedAt`) and that member drops out of every other member's view
  until it is removed and added again;
- it sets another member's epoch to the schema's maximum, after which that
  member's own next entry is past the schema and its rosters are refused
  everywhere;
- it brings a removed device back through a second key it added earlier,
  writing any `addedBy` it likes.

A rule of the form "only D may describe D" cannot be checked when the entry
arrives through B. A signature can.

## Decision

Every roster entry carries signatures, and every member checks them before
an entry takes part in a merge. A device's id is its Ed25519 public key
(`deviceId` in `keys.ts`), so every signature can be checked by every
member without asking anyone.

- **The membership** — id, kind, epoch, `addedBy`, `addedAt` — is signed
  by `addedBy`. `addedBy` must differ from the id: no device adds itself.
  `kind` is what the adder learned at the pairing (the ceremony or the
  relay's pair), never a later claim of the device.
- **The description** — name, os, `links`, `describedAt`, for that epoch —
  is signed by the device itself. Nobody else can change how a device
  reads; a description without the device's signature is not taken.
- **The removal** — `removedBy`, `removedAt`, for that epoch — is signed by
  `removedBy`.
- A higher epoch is taken only when its membership signature is good; the
  epoch has a ceiling far below the schema's maximum, and a member never
  writes past it.
- The merge rule stays (higher epoch, then removed, then later described,
  then the canonical form), applied only to entries whose signatures hold.

Bounds that a signature does not give are part of the same decision: a
merge whose result would exceed the roster's maximum takes no new ids
beyond it, and a roster frame's bound matches what a member may hold.

Roster messages are new in this PR and no shipped device sends one, so the
entry's shape changes without a compatibility path; `PROTOCOL_VERSION`
stays.

## Ruled out

- **Tighter rules without signatures** (`kind` from the pairing, `addedBy`
  equal to the sender, a bound on `describedAt`). Cheaper, but an entry
  passed on by a third member still cannot be told from one that member
  made up.
- **A group key or a group owner** that signs the whole roster. One device
  would hold the group; losing it would end the group, and the design has
  no first member.
- **The roster in the relay.** As before: the relay would hold membership.

## Consequences

- A member can still add or remove any device: that is what being a member
  means ([[joining-one-member-joins-the-group]]). A removed device returns
  only through a member that signs its new epoch, and every member shows
  who that was. A second key the attacker added before the removal is a
  member too; the person removes both.
- A device can only harm its own description. A stolen phone stays a phone.
- The joiner no longer writes a placeholder for the device it joined (it
  cannot sign that device's description); it takes that device's entry
  from its first roster, and the three edge cases of the old rule
  (`docs/fixes/device-group-federation-edges.md` → Roster rule) go with it.
- As built (2026-10-18): a higher epoch replaces a live entry only when
  it is removed or described by the device itself, so no member re-adds
  a live device behind its back; a membership signed by a device removed
  here is refused; a roster frame naming one id twice is ignored; a
  device alone holds a founding entry (epoch 0, never sent) that any
  signed membership replaces; a roster is taken only from a device
  paired here; `ROSTER_MAX_ENTRIES` is 128 so a full roster fits one
  frame, and an add at the bound is refused (`group_full`).
- Two limits stay: two memberships signed at one epoch before the device
  describes itself are settled by the canonical form, and a removed key's
  earlier signatures stay valid history.
- Every entry costs up to three signatures (64 bytes each) in storage and
  on the wire, and a check per signature at each merge.
