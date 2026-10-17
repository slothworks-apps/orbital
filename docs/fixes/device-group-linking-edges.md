---
id: device-group-linking-edges
title: Device group — small edges left in linking, removal and the relay after part 2a
status: backlog
type: fix
domain: remote
related:
  - 2026-10-16-device-group-design
  - device-group
  - 2026-10-17-device-group-roster
tags:
  - remote
  - relay
  - server
---
# Device group — small edges left after part 2a

Found by the reviews of part 2a; each heals on its own or is narrow. None
blocks parts 1–3 shipping together; fix them before or with part 3.

## Server (`server/src/remote/service.ts`)

- **The 429 retry timer skips paired rows.** `retryMutual`'s timer calls
  `link()` without the "paired rows too" flag, so a re-ask for a row whose
  relay pair vanished waits for the next relay `ok` after a 429. Call
  `link(true)` from the timer, or carry the flag with the id.
- **Flush and re-link race on one `ok`.** The pending-revoke flush and
  `link(true)` post on the same tick. An id with a pending revoke that is
  live again in the roster (re-paired elsewhere, no `linked` here yet) can
  be paired by the mutual and then revoked. It heals at a later `ok`. Skip
  pending ids that are live in the roster.
- **A phone moved between Macs.** When a member leaves, it marks removed
  every phone it holds a row for. If that phone was later paired with
  another member while its roster entry stayed live, that member drops its
  working pair. Narrow: it needs the leaver to keep a row the phone never
  revoked.
- **`pendingRevokes.remove`** in `confirmPairing` and in the `paired`
  control is not wrapped in `tryRoster`.
- **A non-retriable 4xx on a pending revoke** keeps it pending and re-posts
  it at every `ok`.
- **A join cancelled after the other member confirmed it** leaves a ghost
  on that member: listed as offline or `linking…`, it locks the member's
  relay and makes it refuse joins with `in_group` until someone removes
  it by hand. The confirming member could drop an entry whose relay pair
  the joiner revoked before it ever linked.
- **No "update Orbital on <name>" for a server member.** Only a phone is
  version-gated; there is no gate between two servers yet, so Settings →
  Devices cannot show a desktop or server member as too old.
- **A regenerated identity** leaves the old self entry live in the roster:
  the old id is not known once the identity file is quarantined. Part 2b's
  UI must let a person remove it.

## Relay (`relay/`)

- **The revoker's own queued wake frames** survive a revoke when the
  revoked device keeps other pairs. Queued frames carry their sender, so a
  filtered drain is possible.
- **Revoke between a mutual offer's lookup and its pair insert** lets the
  pair form after the revoke. One transaction around the lookup and the
  insert closes it.
- **`offerMutual(x, x)`** at the store level would pair a device with
  itself; the route refuses it, the store does not.
- No test covers a phone revoked by its only Mac having its queue drained.

## Shared

- No roster test for duplicate ids inside one input (the behaviour is
  correct); `describeMember`'s comment does not say an `undefined` patch
  value means "no change".
