---
id: device-group
title: The device group — the roster, mutual pairing and removal
type: domain
status: in-force
domain: remote
related:
  - 2026-10-16-device-group-design
  - device-channel
  - joining-one-member-joins-the-group
  - the-group-has-one-primary-device
  - the-relay-pairs-two-devices-that-both-sign
  - a-device-has-one-identity-and-one-channel-per-pair
  - move-a-group-to-another-relay
tags:
  - remote
  - relay
  - server
---
# The device group

How a Mac or a headless server, and the phone through the same shared
code, keep their group today: the roster, linking every member with every
other, removing, leaving and dissolving. The design is spec
`2026-10-16-device-group-design` § 2–§ 4; who writes the roster is ADR
`the-group-has-one-primary-device`, which replaced a roster every member
wrote and merged (ADR `roster-entries-are-signed`, superseded).

## The primary and the roster

One device of the group is its **primary**: the one that founded it. Only
the primary writes who is in the group.

The **roster** is one document the primary signs (`RosterDoc` in
`shared/src/remote/roster.ts`): `group` (the primary's id), `founding`
(random, chosen when the group is founded), `version`, `members` (each
`id`, `kind`, `addedAt`, `addedVersion`), and `dissolved` once the
primary ends the group. The primary is always a member and never a
phone. Beside the document travel:

- **Descriptions** (`name`, `os`, `links`, `describedAt`), each signed by
  the device itself, or by the primary for a device that never describes
  itself (a shipped phone, a Mac from before groups). The device's own
  beats the primary's; with one signer the later wins. `kind` is only
  ever what the ceremony proved — a device-bound proof's sealed device,
  or `phone` for a plain proof — never a hello.
- **Left notices** (`id`, `group`, `founding`, `version`), signed by the
  device that left. A notice holds while the document names the device
  with an `addedVersion` no higher than the notice's version; the primary
  drops a device whose notice holds from its next version.

All of it is one `RosterState`, stored and sent whole; signatures are
canonical base64url over domain-tagged bytes. `ROSTER_MAX_ENTRIES`
bounds the members (a full roster, with every description and notice at
its longest, fits one frame), `ROSTER_MAX_VERSION` the version.

**Taking a roster** (`takeRoster`). A device keeps its `Membership` apart
from the document (`group`, `founding`, the highest `version` taken,
`member`, the founding it `left`, a join's `expires`). It takes a
document only when it is signed by its group's primary, of its founding,
and above the highest version it took — from whichever paired device
passes it on. A device that holds no document (dropped as unreadable)
may take the very version it recorded again. A device joins a group only
through a ceremony: while the founding is still unknown it takes only a
document that names it, is not dissolved and comes from that primary
itself. A device with no membership adopts nothing. Group messages are
taken only from a device paired here.

## Syncing

On a channel's `ready`, once the peer's hello named `group`, each side
sends a `roster_digest`; a different digest is answered with the whole
`roster`. Every `roster` received is acknowledged (`roster_ack`) once
handled. Every change the primary signs is pushed to every channel that
links. Group messages travel only between peers whose hellos both named
the `group` capability (`Channel.sendGroup`, the `group` event), so a
shipped device never sees one.

## Founding and joining

A device alone holds no roster. At a pairing (`ceremony.ts`):

- the side already in a group of two or more is its primary, and adds
  the other; both in groups is refused with `in_group`;
- both alone: the device showing the code founds the group and signs
  version 1 with both; when that is a phone, or a Mac from before groups
  (a code with no `kind`), the device that typed the code founds it; a
  phone typing a pre-group Mac's code founds nothing and keeps a plain
  pair, as before groups;
- a member that is not the primary neither shows nor redeems a code:
  `not_primary`, naming the primary; pairing by hand is the primary's too;
- while a join waits for the primary's first roster (`pendingJoin`,
  until the code expires), the device neither founds nor adds
  (`joining`); cancelling the join restores its membership and ends that
  pair;
- the joining side records the join before it confirms, and asks the
  primary for the roster again once it has; the primary's add is refused
  at `ROSTER_MAX_ENTRIES` (`group_full`) and the pair it just made is
  revoked, never half added;
- phone↔phone is refused on both sides.

A Mac from before this change that holds paired phones founds its group
with them at its first start. A primary whose other members are only its
own phones is not "in a group" (`inGroup`): it may still join another
primary's group, and its phones stay paired with it as its own.

## Linking

`RemoteService.link()` runs after every roster change and on every relay
`ok`. For every member the roster names that links, is not this device
and has no `remote_devices` row yet, it asks the relay once per relay
connection with a signed `POST /pair/mutual { peer }`, never more than
one post in flight per peer, each with `RELAY_POST_TIMEOUT_MS`. At a
relay `ok` it asks for the members that do have a row too, so a pair the
relay lost forms again. The relay forms the pair once the other side has
asked for it.

- **`{ linked: true }`** (the answer, or the `linked` control) makes the
  peer a paired device only when the roster names it and it links;
  otherwise the pair is revoked or ignored. The relay's word never makes
  a device a member.
- **404** (a relay before `/pair/mutual`) marks the peer `pairByHand`;
  only the primary pairs by hand. **429** is asked again after
  `MUTUAL_RETRY_MS`. **A network failure or a 5xx** is tried at the next
  change.

The phone links the same way through `GroupClient`; two phones never
link with each other.

## Removing, leaving, dissolving

All three end pairs through one exit (`endPair`): the document that ends
a pair — the version without the device, the dissolved version, or a
left notice — is recorded with the pair (`exits`), sent on its channel
now or at its next `ready`, and the pair ends (row, channel, watcher,
relay revoke) only when the other side acknowledges it. A device whose
exit is pending is served nothing: `ServingHalf` answers 403
`not_in_group`, sends no hub frame and takes no upload, the watcher
wakes it for nothing, federation drops it. A relay `unpaired` ends a
pending exit; a device that never acknowledges is served nothing, and
after `EXIT_MAX_MS` the pair ends anyway. The check fails closed: an
exit whose stored state no longer reads, or a storage error, still
counts as ending. On the phone the same check (`GroupClient.exiting`)
keeps an ending device out of its sources: no requests, no default, no
notification rules, its wake and hub frames ignored. A
shipped phone, which reads no group messages, ends at once.

- **Removing** (`remove(id)`) is the primary's: another member answers
  403 `not_primary`. The primary signs a version without the device.
  Every member, taking that version, ends its pairs with the devices it
  no longer names.
- **Leaving**, on a member: it signs a left notice and sends it to every
  member it reaches, again every `LEAVE_RESEND_MS` and on any channel
  that comes up, and waits up to `LEAVE_ACK_TIMEOUT_MS` for the first
  acknowledgement; without one it answers `offline` and changes nothing
  (the app offers "Forget this group" locally, which says the group keeps
  listing the device until the primary removes it). A member holding no
  document answers `failed`. With an acknowledgement it becomes alone.
- **Dissolving** is the primary leaving: it signs a last version that
  names only itself, `dissolved`, and every member becomes alone.
- **Becoming alone** (`becomeAlone`): a version that no longer names this
  device, or a dissolved one, ends this device's membership at that
  version, ends the pairs with that group's members (not plain pairs
  with phones outside it), and keeps why and by whom until the user has
  seen the one-time notice (desktop and phone Settings → Devices).
  Rejoining needs a new ceremony; the founding it left stays refused up
  to the version it left at.
- **A relay `unpaired`** ends only that pair, never a membership.

## The relay's part

The relay only ever learns that two keys want a pair; it is never told
why, and never sees a roster. `POST /pair/mutual` (`relay/src/pairing.ts`)
stores each caller's half in `mutual_halves` and inserts it *before*
looking for the other side's half (`RelayStore.offerMutual`), so two
simultaneous requests both see each other rather than both missing it;
once both halves are in it writes the pair (lower device id in the
`mac` column, matching how a phone pair is stored) and sends `linked`
and `presence` to each side exactly once — `created` is true only for
the call that actually formed the pair, so simultaneous requests do not
double-send. A half older than `MUTUAL_PAIR_TTL_MS` is pruned before the
next request is considered. A half is kept only when its peer has a
device row or holds a relay socket now, or when it completes the peer's
waiting half; a signer connected now gets its row then, so two members
pair again after the relay lost its store. Each signer keeps at most
`MUTUAL_HALVES_PER_DEVICE` halves (the oldest goes), and past
`MUTUAL_HALVES_MAX` on the whole relay a new half is refused with 429. `POST /pair/revoke` works for either side of
a mutual pair, same as it already did for a phone pair, and deletes any
waiting half between the two devices along with it — a half signed
before a revoke cannot complete a pair after it. A revoked device's
queued offline frames are drained only once it has no pair left at all
(`peersOf(id).length === 0`), since the queue is kept per recipient, not
per sender.

`/pair/mutual` and `/pair/revoke` draw on a per-IP budget of their own
(`MUTUAL_RATE_LIMIT_PER_MIN` in `relay/src/rateLimit.ts`), not on the
one a WebSocket connect checks (`PAIR_RATE_LIMIT_PER_MIN`): every member
asks for every other at each connection, and that must never lock a
device behind the same address out of connecting. The secret is checked before
this budget is charged, and a device the relay knows has its own share
of its address's budget, so throwaway keys from a page on the same
network cannot use up a member's. A wrong relay secret
on either route still counts against the guessing budget, and past it
they are refused like a connect, so the secret is not guessed faster
through them.

## What the status shows

`status.group`: `primary` (`{ id, name }`, null while alone), `isPrimary`,
`pendingJoin` (`{ primary, expiresAt }` while a join waits), the
one-time notice of how this device became alone, `relayLocked` (the
relay is fixed while in a group, idea `move-a-group-to-another-relay`),
and `members`, one row per member the roster names: `primary`, `state`
(`self`, `online`/`offline` by the relay's presence, `linking` while a
mutual pair is asked, `notLinked` for `pairByHand`), `seenAt`, `tooOld`.
A device paired outside any group (a pre-group Mac paired from a phone, a
primary's own phones after it joined another group) is listed under
`devices` only. Settings → Devices shows a phone not paired here as
`paired with <its desktop>`.

## Known limits

- **A member asleep at a removal** still links with the removed device
  until a newer version reaches it, from any member.
- **A stolen, unlocked primary** controls the group; there is no handover
  yet (idea `transfer-the-primary-role`). Losing the primary means every
  member leaves and founds again.
- **Adding needs the primary** awake and at hand.
- **Two members a relay cannot pair** (a relay before `/pair/mutual`)
  stay `not linked`: only the primary pairs by hand.
- **The joining side of a full group** reads "Request rejected"; only
  the primary is told the group is full (the relay carries no reason).
- **A device asleep longer than `EXIT_MAX_MS`** after its removal does
  not learn of it by message: its pairs are gone when it wakes, and it
  still shows the group until it leaves.
- **After this device's identity is regenerated** it drops its roster
  (it named the old key); the old id stays in the group until the
  primary removes it.
- **The server's `RelayClient` and the phone's `RelayLink`** are two
  implementations of one relay protocol.

## Storage

- On a Mac or a server (migration `0029_device_group`):
  `group_roster` (the document's head), `group_members`,
  `group_descriptions`, `group_left`, `group_membership` (the membership
  and the notice of how it ended), `group_exits` (pending exits),
  `pending_revokes` (revokes the relay has not answered yet), through
  `RosterStore` and its neighbours in `server/src/remote/rosterStore.ts`.
- On the phone: `orbital.group` (`StoredGroup`: the state, the
  membership, the exits), and the marker `orbital.group.seen`, so a phone
  is migrated from `orbital.pairing` only when it never had a group
  record.
- On the relay: `mutual_halves`; a formed pair lives in `pairs`.

## Where each piece lives

| piece | file |
|---|---|
| the document, descriptions, notices, `takeRoster` | `shared/src/remote/roster.ts` |
| the member: roster writes, sync, linking, exits, leave | `shared/src/remote/group.ts` (`GroupMember`) |
| showing and redeeming codes, who founds and adds | `shared/src/remote/ceremony.ts` |
| the phone's host | `shared/src/remote/groupClient.ts` |
| the server's host and status | `server/src/remote/service.ts` |
| storage | `server/src/remote/rosterStore.ts`, `web/src/mobile/platform/group.ts` |
| the relay's mutual pair | `relay/src/pairing.ts`, `relay/src/store.ts` |
