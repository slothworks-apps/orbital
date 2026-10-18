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
  - move-a-group-to-another-relay
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
to link), `epoch`, `addedBy`, `addedAt`, `describedAt`, `describedBy`,
and, once removed, `removedBy` and `removedAt`. `isLive` is simply "no
`removedAt`". The type, its schema and the merge live in
`shared/src/remote/roster.ts`; `ROSTER_MAX_ENTRIES` bounds how many a
member holds and a channel frame carries.

**Every entry is signed** (ADR `roster-entries-are-signed`). A device's
id is its Ed25519 public key, so any member checks any signature on its
own. Three parts, each over a fixed-order array opened by a domain tag:

| part | covers | signed by |
|---|---|---|
| membership (`addedSig`) | id, kind, epoch, `addedBy`, `addedAt` | `addedBy`, never the id itself |
| description (`describedSig`) | id, epoch, `addedSig`, name, os, links, `describedAt`, `describedBy` | the device itself, or its adder until the device describes itself |
| removal (`removedSig`) | id, epoch, `removedBy`, `removedAt` | `removedBy` |

`verifyEntry` checks every part (canonical base64url signatures only,
`signatureOf` in `keys.ts`), an epoch between 1 and `ROSTER_MAX_EPOCH`,
and a removal that is whole or absent; a verified entry is remembered by
its canonical form (`verifiedOnce`, a bounded cache), so a roster sent
again costs no checks. `kind` comes from the pairing — the sealed device
of a device-bound proof, or `phone` for a plain proof — never from a
hello. A description covers its membership's signature, so it belongs to
one membership at one epoch: a device describes itself only under a
membership of its own kind, and a member that re-signs a device's
membership with another kind cannot carry the device's description over.

`mergeRoster` takes an incoming entry only when it verifies, and decides
per id:

- an entry held here that is a **founding entry** (below) gives way to
  any membership;
- the **same epoch** combines part by part — the device's own
  description beats its adder's, a removal beats none — the same in
  either order;
- a **higher epoch** replaces a *removed* entry with any valid
  membership (a re-add, by someone other than the device), but a *live*
  entry only when the incoming one is removed or described by the device
  itself — no member re-adds a live device behind its back;
- a membership that is new here and whose `addedBy` is removed here is
  refused: a removed device adds nobody;
- a lower epoch is ignored; a merge takes no new id once the roster is
  full, and `addMember` refuses one (the pairing answers `group_full`).

A roster frame that names one id twice is ignored whole. `rosterDigest`
hashes the shareable roster (sorted by id, the canonical form) so two
members can tell whether they agree without sending it.

**The founding entry.** A device alone holds its own entry at epoch 0,
added by itself (`foundingEntry`). It is never sent and never part of
the digest; the first member that pairs with it signs its real
membership. Leaving writes the founding entry again.

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
Receiving a `roster` from a device paired here merges it with `mergeRoster` and,
if the sender's own merge of this side's roster would change it, answers
with this side's own `roster` in turn — the sender may be missing
something only this side knew. Two members that each keep an entry the
other does not take therefore stop after one answer rather than trading
rosters forever. So two members converge within a few round trips of opening a
channel, and after that only an actual change moves anything.

Group messages (`roster_digest`, `roster` — `GroupMessage` in
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
  platform, `links: true` — each cut to the bound the roster schema reads
  it within (`PAIR_NAME_MAX_CHARS`, `ROSTER_KIND_MAX_CHARS`), since one
  entry past a bound makes every other member refuse the whole roster.
  Alone, that entry is the founding entry; once a member has signed its
  membership, `setRoster` re-signs its own description whenever it no
  longer says what this device says of itself (`describedSelf`), so a
  rename travels in the roster. A rename made while the remote was off
  is picked up the next time the remote starts.
- **A newcomer, at pairing.** Confirming an incoming pair signs the new
  device's membership with the kind the ceremony proved — a device-bound
  proof's sealed device, `links: true`; a plain proof (a shipped phone)
  `kind: 'phone'`, `links: false` (`addPaired`). At `ROSTER_MAX_ENTRIES`
  the request is rejected with `group_full`. The joiner writes nothing at
  `paired`: it takes the joined device's entry from that device's first
  roster, and signs it itself only when that roster does not name it
  (the joined device was alone).
- **What a hello describes.** Every channel's `hello` event calls
  `onPeerHello`. A device that keeps no roster (a shipped phone, a Mac
  from before groups) is added there by the device holding its pair,
  with the paired row's kind; afterwards its adder re-describes it from
  its hello (`name`, `os`, `links`) for as long as the device has not
  described itself. `kind` is never taken from a hello.
- **Removal and leaving** write through `removeMember` and the founding
  entry as below.

## Linking

`RemoteService.link()` runs after every roster change that actually
took effect and on every relay `ok` (a fresh relay connection). For
every live roster entry that links, is not this device itself, and has
no `remote_devices` row yet, it asks the relay once per connection
(`mutualAsked`, cleared on the next `ok`) with a signed `POST
/pair/mutual { peer }`. At a relay `ok` it asks for the members that do
have a row too: the relay answers `{ linked: true }` while it still
holds the pair, and otherwise keeps the half until the other side asks —
so a pair the relay lost while this side kept its row (the other side
revoked it while this one was away) forms again. The relay forms the
pair only once the other side has asked for the same pair, so the first
member to ask simply waits — nothing happens on this side until the relay answers `{ linked:
true }` or sends the `linked` control once the other half arrives.

What happens to the answer:

- **`{ linked: true }`**, from the post's own answer or from the `linked`
  control, is handled identically by `onLinked`, which reads the roster
  for that peer and has exactly three outcomes: an entry that is removed
  revokes that pair straight back out (`revokeAtRelay`) — the pair asked
  for before the removal reached the relay is undone, not kept; no entry
  at all, or a live entry that does not link, is ignored and logged — the
  relay's word alone never makes a device a member; only a live entry
  that links becomes a paired device (a `remote_devices` row if there was
  none yet, `publishStatus`, a channel opened to it).
- **404** (the relay predates `/pair/mutual`) marks the id `pairByHand`
  in memory until the next relay `ok` clears it, and is shown as such in
  the status.
- **400** (a bad request) is left asked until the next relay `ok`
  starts the asking over.
- **429** (rate-limited) is asked again after `MUTUAL_RETRY_MS`, or at
  the next relay `ok` if that comes first; the timer is cleared by an
  `ok` and by any stop, so a stopped remote asks nothing.
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
  open, it is sent the signed roster that says so and then the channel closes with
  `bye revoked`; its watcher stops, its `remote_devices` row goes, and
  its relay pair is revoked (`POST /pair/revoke`) — posted even when
  there was no row, so a mutual half still waiting at the relay for this
  device goes too. Every revoke is written to `pending_revokes` first and
  leaves it only once the relay answers 200 or 404 (no such pair); one
  the relay could not be told — offline, a network failure, a 5xx — is
  posted again at every relay `ok`. A device paired afresh (a ceremony
  or a `linked`) drops a revoke still waiting for it.
- **Removing this device itself** (`leaveGroup`) — by `leave()`, and by
  `remove()` given this device's own id, which is `leave()` with its
  refusal while offline — first marks removed, in the roster it is about
  to send, every live `phone` entry this device has a `remote_devices`
  row for (those pairs go in this same leave, and no other member can
  reach such a phone); then tells every open channel the roster and
  closes it with `bye revoked`; revokes every
  paired device's relay pair, and separately revokes any live, linking
  member this device was never paired with but might have a mutual half
  waiting with; stops every watcher; and finally writes a fresh roster
  holding only this device's founding entry — a group of one. A roster
  is taken only from a device paired here, so one still in flight from a
  former member does not bring the old group back. `leave()` itself only runs while the relay is online: offline,
  nothing reaches anyone else and the group-of-one write would
  overwrite the removal before it ever spread, so it answers `{ error:
  'offline' }` instead (409 from both `POST /api/remote/leave` and
  `DELETE /api/remote/devices/<own id>`). A roster write that fails
  answers `{ error: 'failed' }` (500), never `ok`.
- **Learning of its own removal from a peer**: a roster whose entry for
  this device is removed, with a good removal signature, is handled as
  `leaveGroup` above.
- **A relay `unpaired` control** for a device with a `remote_devices`
  row means the other side revoked the pair directly; the row, channel
  and watcher go, but the roster is not touched by this alone — only a
  roster that marks the device removed ends its membership. The relay's word about a pair is
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

## Joining, and what the status shows

`RemoteService.join(code)` refuses with `in_group` while this device is
in a group (`inGroup`) and the code's device is not itself a live member,
before
anything is sent to the relay: groups do not merge, a device leaves its
group before it joins another (ADR `joining-one-member-joins-the-group`),
while a code from a member of its own group is pairing by hand.
A phone refuses another phone on both sides of a code: joining with a
code whose kind is `phone` answers `phone_to_phone` before anything is
sent, and a phone showing its code rejects a request from a phone at the
relay without asking, keeping it as the ceremony's `refused`
(`GroupClient.refusedPair`) for the screen to word.
"In a group" (`hasOtherGroupMember`) means the roster holds a live member,
other than this device, that links or that is not paired here (no
`remote_devices` row). A phone paired here makes no group: a Mac whose
only other devices are its own phones changes its relay and joins as it
did before the group existed. A phone another member paired does count —
this device is in that member's group.
A roster that cannot be read counts as a group of one, as in the status. `other_relay` names the code's
relay, `peer_offline` the code's `expiresAt` when the code carries one
(`QrPayload.expiresAt`, which `startPairing` copies from the relay's
answer). While a join waits, `status.joining` carries the formatted code
to type on the other device and the code's expiry, so a reload keeps the
waiting card; `cancelJoin` (`DELETE /api/remote/join`) drops it here and
leaves the relay's request to expire. The cancelled join is remembered
until the code's expiry (`cancelledJoin`); a `paired` for that device in
that window is revoked at the relay and the device is never added. The
joining's expiry is the code's, never more than `PAIRING_TOKEN_TTL_MS`
from now.

`status.group.members` lists only live members — removed entries stay in
the store — each with a `state`: `self`; `online`/`offline` by the
relay's presence for a member paired here (with `seenAt` from its
`remote_devices` row) and for a member that does not link (a phone
paired with another member, never "not linked"); `linking` for a member
that links and is not paired here yet; `notLinked` for one marked
`pairByHand`. `status.group.relayLocked` is `inGroup`: while it holds,
`PATCH /api/settings` refuses a changed `remote_relay_url` or
`remote_relay_secret` with 409 `in_group` (idea
`move-a-group-to-another-relay`). Settings → Devices shows a phone that
is not paired here (another member paired it) as `paired with <adder>`,
with no presence dot: this device has no pair with it, so the relay's
presence says nothing about it here.

## Known limits

- **A join cancelled after the other member confirmed it**: the joiner
  revokes the pair the relay made, but the member that confirmed has
  already written the joiner into its roster, and is left with a ghost
  until someone removes it: the member lists it as `offline` or
  `linking…`, its relay is locked (the ghost is a live member it is not
  paired with), and its joins are refused with `in_group`. Removing the
  ghost from Settings → Devices clears all three.
- **No "update Orbital on <name>" for a server member.** There is no
  version gate between two servers yet, so a desktop or server member too
  old for this one is never shown as needing an update; only a phone is
  (`needs an update`).

- **A peer that is asleep when another member leaves, or that receives
  the relay's `unpaired` before the leaver's roster message** keeps the
  leaver listed as a live but unlinked member until a person removes it
  by hand. The roster only ever changes by a signed roster entry, never by the
  relay's `unpaired` alone, so the relay cannot make a member disappear from anyone's
  roster on its own.
- **Removed entries are never pruned.** A removal has to outlive the
  device it removed, so the roster only ever grows: `ROSTER_MAX_ENTRIES`
  is a limit on how many devices a group can ever have held, not on how
  many it holds now.
- **A member's word is trusted group-wide.** Any member signs adds and
  removals, so a stolen key adds and removes devices until it is removed
  itself; it cannot change how another device describes itself, nor
  re-add a live device. A device's `kind` is what it proved at pairing.
- **Two memberships at one epoch, before the device describes itself.**
  A member that signs a competing membership for a fresh add before the
  device's own description arrives may win the tie on the canonical form;
  for a device that never describes itself (a shipped phone, a Mac from
  before groups) that holds until it is removed and added again.
- **A removed key still signs history.** Entries it signed before its
  removal stay valid and are passed on; only new memberships it signs are
  refused.
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
  separate warning that a phone loses its only route to that Mac; the
  leaver marks those phones removed in the roster it sends, so the
  others do not keep them as live members no one can reach. The UI that
  should warn about this before someone leaves is part of 2b,
  not built yet.

## Storage

- On a Mac or a server: `group_members` (`server/src/db/schema.ts`,
  migrations `0029_group_roster` and `0032_signed_roster`, which added
  the signatures and dropped the unsigned rows), one row per roster entry, read and
  written through `RosterStore`. This is a deviation from spec § 2
  "Storage", which described the roster as columns added to
  `remote_devices`; as built, `remote_devices` holds only the devices
  this one actually has a relay pair with — a paired device is a
  subset of the roster, not the same table.
- On a Mac or a server: `pending_revokes` (migration
  `0030_pending_revokes`), one row per revoke the relay has not answered
  yet, read and written through `PendingRevokes` in the same file.
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
| revokes waiting for the relay | `server/src/db/schema.ts` (`pendingRevokes`), `server/src/remote/rosterStore.ts` (`PendingRevokes`) |
| the relay's budgets | `relay/src/rateLimit.ts`, `relay/src/pairing.ts` (`signed`) |
| the self entry, pairing, sync, linking, removal, leaving | `server/src/remote/service.ts` (`addSelf`, `addPaired`, `onPeerHello`, `setRoster`, `applyRemovals`, `link`, `onLinked`, `remove`, `leave`, `leaveGroup`, `dropMember`) |
| the status the UI (part 2b) reads, joining and its refusals | `server/src/remote/service.ts` (`RemoteStatus.group`, `listGroup`, `inGroup`, `join`, `cancelJoin`); the relay URL lock in `server/src/api/routes.ts` (`PATCH /api/settings`) |
