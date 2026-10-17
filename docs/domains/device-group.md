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
  - the-relay-pairs-two-devices-that-both-sign
  - a-device-has-one-identity-and-one-channel-per-pair
tags:
  - remote
  - relay
  - server
---
# The device group

How a Mac or a headless server's own view of its group — the roster, the
links to every other member, removal and leaving — is built today. This
is part 2a of the device group work (spec
`2026-10-16-device-group-design` § 2–§ 4): the roster and the relay's
mutual pair, without the Settings UI (part 2b) and without federating
requests over the links (part 3). The phone is a member in this part
only in the sense that it is listed; it names no `group` capability, so
it never links with anyone and never carries a roster message — the
channel work that applies to it is `docs/domains/device-channel.md`.

## The roster entry and the merge

A roster is an array of entries, one per device id: `kind`, `name`,
`os`, `links` (the device named the `group` capability and so is asked
to link), `epoch`, `addedBy`, `addedAt`, `describedAt`, and, once
removed, `removedBy` and `removedAt`. `isLive` is simply "no
`removedAt`". The type and its schema live in `shared/src/remote/
roster.ts`, with `ROSTER_MAX_ENTRIES` bounding how many a channel frame
carries.

Two rosters merge entry by entry, by `winner`: the higher `epoch` wins
outright; within one epoch a removed entry beats a live one; within
that, the later `describedAt` wins; and if even that ties, a
fixed-order canonical form of the entry breaks it so every member
computes the same winner. The winner is always one whole entry, never a
field-by-field blend. `mergeRosters` is commutative — merging A into B
gives the same roster as merging B into A — which is what lets every
member converge without a single source of truth, and `rosterDigest`
hashes the merged roster (sorted by id, keys in a fixed order) so two
members can tell whether they agree without sending the whole thing.

Because a removal only ever wins by `epoch` and then by being removed,
a member that comes back online with a stale, still-live entry for a
device cannot undo another member's removal of it: the removed entry
either shares the epoch (and wins, being removed) or carries a higher
one written by whoever re-added the device through a new pairing
ceremony. A device is only ever added again by such a ceremony, which
writes the next epoch after whatever epoch is already known for its id
(`addMember`).

## Syncing the roster over the channels

Every `RemoteService` keeps its own roster in `RosterStore`
(`server/src/remote/rosterStore.ts`), backed by its own table,
`group_members` — see Storage, below. The store's `replace` writes a
whole roster atomically and reports whether anything actually changed;
every write to the roster goes through `RemoteService.setRoster`, which
calls `replace` and, only on a real change, applies whatever the change
removed (see Removal), publishes the status, and pushes a fresh
`roster_digest` to every other channel whose peer links — "every other"
because the channel the change came in on (if any) is passed as
`setRoster`'s `from` and skipped, so the two sides of one exchange do
not just echo it back and forth.

A channel's own `ready` event, once its peer's hello named `group`,
sends this side's `roster_digest` first. Receiving a `roster_digest`
that does not match this side's own answers with the whole `roster`.
Receiving a `roster` merges it in with `mergeRosters` and, if the
result still does not match what was sent, answers with this side's own
`roster` in turn — the sender may be missing something only this side
knew. So two members converge within a few round trips of opening a
channel, and after that only an actual change moves anything.

Group messages (`roster_digest`, `roster`, `removed` — `GroupMessage` in
`shared/src/remote/messages.ts`) travel only between two peers that both
named the `group` capability in their hello: `Channel.sendGroup` checks
`this.groups` (the peer's hello named it) before sending, and the
receiving side's `Channel` only emits the `group` event when its own
view of the sender's hello (`this.groups`) says so too — checked on both
send and receive, so a shipped device that knows nothing about the
group never sees one of these messages, by construction rather than by
convention. The phone's capabilities stay `[]` in this part, so it never
links and never takes part in the roster sync; it is merely an entry
other members carry (`kind: 'phone'`, `links: false`).

## Who writes what

- **Its own entry.** Each `RemoteService` adds itself to its own roster
  the first time it starts with none (`addSelf`): `kind` from
  `serverDeviceKind()`, `name` from the Mac name, `os` from the running
  platform, `links: true`. If its name changes while it already has a
  live entry, it re-describes itself (`describeMember`); a rename made
  while the remote was off is picked up the next time the remote starts.
- **A newcomer, at pairing.** Confirming an incoming pair, or finishing
  a join through another member, adds the new device with `links:
  false` and whatever the pairing ceremony knew about it (`addPaired`).
  `links` only becomes true once that device's own hello says so — the
  roster never takes a device's word about itself from the pairing
  ceremony alone.
- **What a hello describes.** Every channel's `hello` event calls
  `onPeerHello`: it patches the peer's live entry with its `name` (or
  `macName`), its `os`, and `links = channel.groups` (whether its hello
  named the `group` capability) — only the fields the hello actually
  carries. A device paired before the roster existed (an old phone) gets
  a first entry here instead of a patch.
- **Removal and leaving** write through `removeMember`/`addMember` as
  below.

## Linking

`RemoteService.link()` runs after every roster change that actually
took effect and on every relay `ok` (a fresh relay connection). For
every live roster entry that links, is not this device itself, and has
no `remote_devices` row yet, it asks the relay once per connection
(`mutualAsked`, cleared on the next `ok`) with a signed `POST
/pair/mutual { peer }`. The relay forms the pair only once the other
side has asked for the same pair, so the first member to ask simply
waits — nothing happens on this side until the relay answers `{ linked:
true }` or sends the `linked` control once the other half arrives.

What happens to the answer:

- **`{ linked: true }`**, from the post's own answer or from the `linked`
  control, is handled identically by `onLinked`: only when the roster
  still holds a live entry for that peer that links does it become a
  paired device (a `remote_devices` row, `publishStatus`, a channel
  opened to it). A `linked` for an entry the roster does not hold live —
  or does not hold at all — is ignored and logged; the roster, never the
  relay's word alone, decides who is linked. A `linked` for an entry
  that was removed in the meantime revokes that pair back out
  (`revokeAtRelay`) instead of linking it.
- **404** (the relay predates `/pair/mutual`) marks the id `pairByHand`
  in memory until the next relay `ok` clears it, and is shown as such in
  the status.
- **400 or 429** (a bad request, rate-limited) is left asked until the
  next relay `ok` starts the asking over.
- **A network failure or a 5xx** un-marks the id as asked, so the very
  next roster change tries it again.

The phone is never linked this way: its roster entry has `links: false`
(it names no `group` capability), so `link()` skips it outright.

## Removal and leaving

`RemoteService.remove(id)` is how any member — any removal, from any
member's Settings or MCP — takes a device out of the group. It marks
the roster entry removed at its current epoch (`removeMember`) and
writes the roster through `setRoster`, whatever state the relay
connection is in; a device that was paired before the roster existed
(an old phone) gets a roster entry first, so it has something to mark
removed. `setRoster`'s `applyRemovals` then acts on every entry the
write actually removed (one that was live, or unknown, just before):

- **Removing someone else** (`dropMember`): while its channel is still
  open, it is told `{ t: 'removed' }` and then the channel closes with
  `bye revoked`; its watcher stops, its `remote_devices` row goes, and
  its relay pair is revoked (`POST /pair/revoke`) — posted even when
  there was no row, so a mutual half still waiting at the relay for this
  device goes too.
- **Removing this device itself** (`leaveGroup`) — including by
  `leave()`, which is exactly `remove(self)` — tells every open channel
  the roster (not `removed`: that message means "you were removed", and
  this device was not) and closes it with `bye revoked`; revokes every
  paired device's relay pair, and separately revokes any live, linking
  member this device was never paired with but might have a mutual half
  waiting with; stops every watcher; and finally writes a fresh roster
  holding only this device's own entry, at its next epoch — a group of
  one. `leave()` itself only runs while the relay is online: offline,
  nothing reaches anyone else and the group-of-one write would
  overwrite the removal before it ever spread, so it answers `{ error:
  'offline' }` instead.
- **Learning of its own removal from a peer**: a `removed` group
  message means "you were removed" — the sender is a member that
  already knows — and is handled as `leaveGroup` above.
- **A relay `unpaired` control** for a device with a `remote_devices`
  row means the other side revoked the pair directly; the row, channel
  and watcher go, but the roster is not touched by this alone — only a
  roster write (a `removed` message, or a roster that already marks the
  device removed) ends its membership. The relay's word about a pair is
  not the relay's word about the group.

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
next request is considered. `POST /pair/revoke` works for either side of
a mutual pair, same as it already did for a phone pair, and deletes any
waiting half between the two devices along with it — a half signed
before a revoke cannot complete a pair after it. A revoked device's
queued offline frames are drained only once it has no pair left at all
(`peersOf(id).length === 0`), since the queue is kept per recipient, not
per sender.

## Known limits

- **A peer that is asleep when another member leaves, or that receives
  the relay's `unpaired` before the leaver's roster message** keeps the
  leaver listed as a live but unlinked member until a person removes it
  by hand. The roster only ever changes by a roster write — a `removed`
  message or an already-removed entry — never by the relay's `unpaired`
  alone, so the relay cannot make a member disappear from anyone's
  roster on its own.
- **A removal applied while the relay is offline** revokes nothing at
  the relay later: `revokeAtRelay` is a best-effort call made at the
  time of removal, with no retry once the relay comes back. The other
  members still learn of the removal once a channel reopens and the
  roster converges; only the relay-side pair (and, if the removed device
  is a phone, its push token) can be left stale until that device's own
  pair is separately revoked.
- **After this device's identity file is unreadable and regenerated**,
  its old self entry in the roster is left live: the old key, and the
  id derived from it, is simply gone, so nothing can mark that entry
  removed. Every other member still carries it until it ages out by
  some later ceremony.
- **A description can lose to a later, wrong clock.** `describeMember`'s
  winner within one epoch is decided by `describedAt`; a member whose
  clock runs ahead can make its description of a peer — or of itself —
  stick over a more recent one, which can undo a rename until the next
  one is written. The roster still converges to one answer everywhere;
  it is just not always the newest one a human would pick.
- **Leaving drops every phone paired with that device.** `leaveGroup`
  revokes every paired device's relay pair, phones included, with no
  separate warning that a phone loses its only route to that Mac. The
  UI that should warn about this before someone leaves is part of 2b,
  not built yet.

## Storage

- On a Mac or a server: `group_members` (`server/src/db/schema.ts`,
  migration `0029_group_roster`), one row per roster entry, read and
  written through `RosterStore`. This is a deviation from spec § 2
  "Storage", which described the roster as columns added to
  `remote_devices`; as built, `remote_devices` holds only the devices
  this one actually has a relay pair with — a paired device is a
  subset of the roster, not the same table.
- On the relay: `mutual_halves` (migration `0003_mutual_halves`), one
  row per half still waiting; a formed pair lives in `pairs`, same table
  a phone pair already used.
- The phone keeps no roster of its own in this part: it is not a member
  that links, so there is nothing for it to converge.

## Where each piece lives

| piece | file |
|---|---|
| the roster type, merge, digest, add/remove/describe | `shared/src/remote/roster.ts` |
| `GroupMessage`, the `group` capability | `shared/src/remote/messages.ts`, `shared/src/remote/device.ts` |
| sending and receiving group messages on a channel | `shared/src/remote/channel.ts` (`sendGroup`, `groups`, the `group` event) |
| `pair.mutual`, the `linked` control, `MUTUAL_PAIR_TTL_MS` | `shared/src/remote/relayApi.ts` |
| the relay's mutual-pair table and route | `relay/migrations/0003_mutual_halves.ts`, `relay/src/store.ts` (`offerMutual`, `revokePair`), `relay/src/pairing.ts` (`POST /pair/mutual`) |
| the roster table and its store on a Mac or a server | `server/src/db/schema.ts` (`groupMembers`), `server/src/remote/rosterStore.ts` |
| the self entry, pairing, sync, linking, removal, leaving | `server/src/remote/service.ts` (`addSelf`, `addPaired`, `onPeerHello`, `setRoster`, `applyRemovals`, `link`, `onLinked`, `remove`, `leave`, `leaveGroup`, `dropMember`) |
| the status the UI (part 2b) will read | `server/src/remote/service.ts` (`RemoteStatus.group`, `listMembers`) |
