---
id: 2026-10-16-device-group-design
title: Device group — every device of one person talks to every other directly
status: draft
type: spec
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - remote-identity-is-ed25519-with-ephemeral-session-keys
  - the-phone-tunnels-the-api-behind-an-allowlist
  - the-phone-may-do-what-the-mac-may
  - a-phone-feature-waits-for-the-mac-that-serves-it
  - a-device-has-one-identity-and-one-channel-per-pair
  - joining-one-member-joins-the-group
  - the-relay-pairs-two-devices-that-both-sign
  - every-member-reaches-one-literal-allowlist
  - a-headless-orbital-is-a-full-member
  - move-a-group-to-another-relay
tags:
  - remote
  - relay
  - server
  - web
  - mobile
---
# Device group

## Problem

One person runs Orbital on several machines: a laptop that travels and
is often closed, a Mac at home that stays on, soon a headless Linux
server that never sleeps, and one phone. Each should see and drive the
sessions of every other, and none should depend on a third being awake:
with the laptop shut, the phone still reaches the home Mac and the
server, and a session on the server can start work on the home Mac.

PR #79 (peer Macs) built the first half for two Macs: a Mac becomes a
client of another by registering a second identity with the relay as a
phone, and a phone reaches a second Mac through the first. That shape
does not carry to a group: a device is a different key per role, trust
is decided by the platform a device names for itself, and anything that
travels through a third device stops when that device sleeps. This spec
replaces it; the federation in the local server, the request routing and
the tag mapping from #79 are kept.

## Decisions taken while brainstorming

| question | decision |
|---|---|
| what pairs with what | every device with every other, directly; no device reaches another through a third |
| who is in it | Macs (desktop), Linux servers (headless), the phone; the model is N of any kind |
| how a device joins | one ceremony with any member; that member introduces it to the rest ([[joining-one-member-joins-the-group]]) |
| identity | one Ed25519 key per device, one relay socket, one encrypted channel per pair, used in both directions ([[a-device-has-one-identity-and-one-channel-per-pair]]) |
| how two members get a relay pair without a ceremony | both sign a request to the relay ([[the-relay-pairs-two-devices-that-both-sign]]) |
| what a member may call on another | one literal allowlist for every member, the phone included ([[every-member-reaches-one-literal-allowlist]]) |
| the headless server | a full member: runs sessions, has no map, reaches the others through its MCP ([[a-headless-orbital-is-a-full-member]]) |
| relays | one relay per group |

Ruled out: extending #79 with a key per role (a device is a set of keys,
which makes introducing and removing it bookkeeping); keeping the group in
the relay (the relay would hold membership, needs a migration of its
pairing model, and learns more than it has to); pairing each pair by hand
(six ceremonies for four devices); confirming every introduction on every
member (the person already consented once, on two of their own devices).

## Scope

- **For:** anyone running Orbital on more than one machine, or on a
  machine and the phone.
- **Lives:** on by default. A device alone is a group of one, and nothing
  changes for it until a second device joins.
- **An existing user notices:** nothing on the Mac until they add a
  device. Settings → Mobile becomes Settings → Devices, which lists the
  phone already paired as a member. A phone already paired keeps working
  without pairing again.
- **Can be set:** which devices are in the group (add, rename this
  device, remove any); the device filter chips on the map and the phone;
  the relay, only while the device is alone (§ 4).

## 1. Members

- **A device is one key.** A Mac or a Linux server uses the host identity
  it already has (`remote-identity.json`); the phone uses the identity it
  already has in secure storage. The device id is `deviceId(publicKey)`,
  as today.
- **Kind** is one of `desktop`, `headless`, `phone`. It is sealed into the
  pairing request with the name and the OS, shown in the confirmation
  ("Ubuntu server *vps* (headless) wants to join"), and from then on read
  from the roster, never from what the device says about itself later.
- **OS** (`macos`, `linux`, `ios`, `android`) and the app version are
  information: they name the device in the UI and say what to update.
- **A device belongs to one group.** Every device starts as a group of
  one, so there is no "create a group" step.

## 2. The roster

Every member keeps the whole roster and they converge on it.

- **An entry:** `id`, `kind`, `epoch`, `addedBy`, `addedAt`, and, once
  removed, `removedBy`, `removedAt`. `name`, `os` and `version` are what
  the device said in its last `hello` (§ 5); only the device itself
  changes them.
- **Merging two rosters** takes, per id, the entry with the higher
  `epoch`; within one epoch a removed entry wins over a live one. So a
  member that comes back online with a stale roster cannot bring a removed
  device back. A device is added again only by a new ceremony on some
  member, which writes the next epoch.
- **Sync.** When a channel opens, both sides send a digest of their
  roster; on a difference they send the whole roster (a few hundred
  bytes per member) and both merge. Every change is pushed to every open
  channel. A change made while some member is offline reaches it at its
  next channel with anyone.
- **Storage.** On a Mac and a server: the `remote_devices` table gains
  `kind`, `epoch`, `added_by`, `removed_by`, `removed_at` (one migration;
  the phones already in it become `kind: 'phone'`, epoch 1, added by this
  Mac). On the phone: secure storage, beside its identity.

## 3. Joining

1. On any member, Settings → Devices → **Add a device** shows a code: the
   QR on a Mac (the phone scans it), the same payload as one word to copy
   (another Mac or a server pastes it). A server shows it with
   `orbital devices add`.
2. The new device scans or pastes it and redeems it with the relay, as a
   phone does today, sealing its name, kind and OS.
3. The member shows the 6-character code the new device displays and the
   user types it there (as for a phone today; a server prompts in the
   terminal).
4. The member writes the new device into the roster at the next epoch
   and pushes the roster to it and to everyone else. The members then
   link with it (§ 4); nothing more is asked of the user. Every member
   says once, in Settings → Devices, "*vps* added by *studio*".

**Two groups meet.** A device already in a group of two or more cannot
join a device of another group; it leaves first (design 50, decided
2026-10-17). A code from a member of its own group is still taken: that
is "pair by hand" (§ 4). The roster's merge still converges if two
groups ever meet, but no ceremony starts it.

## 4. Links

A link is the relay pair between two members and the channel over it.

- **Every member links with every other.** Whenever the roster lists a
  live member it has no relay pair with, it sends its half of a mutual
  pair to the relay (`POST /pair/mutual`, signed, naming the other
  device). The relay creates the pair once both halves are in and drops a
  half that waits longer than `MUTUAL_PAIR_TTL`. Both sides learn the
  other's key from the roster, which arrived over an authenticated
  channel, so the relay can neither invent a pair nor sit in the
  channel ([[the-relay-pairs-two-devices-that-both-sign]]).
- **A relay without `/pair/mutual`** (a self-hosted one not updated): the
  members it would link are listed as "not linked" with "pair by hand",
  which runs the ceremony between those two.
- **Removing a member**, from any member: the roster marks it removed;
  every member revokes its own pair with it at the relay
  (`/pair/revoke`, as for a phone today) and refuses its channel from then
  on; a member still talking to it tells it `removed`, and the removed
  device forgets the group and becomes a group of one. The phone revokes
  its push token for every member it leaves, as "Pair a different Mac"
  does today.
- **Leaving** is removing this device, from this device.
- **The relay** is the group's: the relay field is editable only while
  the device is alone, and read-only while another member is live.
  Moving a whole group to another relay is not built yet
  ([[move-a-group-to-another-relay]]).

## 5. The channel

- **One socket per device**, as the relay already allows: every link's
  frames travel over it, addressed by the peer's key, as they are today.
- **One channel per link, used in both directions.** The handshake
  (`remote-identity-is-ed25519-with-ephemeral-session-keys`) needs an
  initiator and a responder: a phone always initiates, as it does today;
  a device paired through an older Mac's code, which names no kind,
  initiates towards that Mac, since the Mac only ever answers; between
  two other members the lower device id initiates. Whoever initiates, a
  device answers a handshake that arrives while it has no channel.
- **Ask ids** are the asker's own: the initiator numbers from 1, the
  responder from `RESPONDER_FIRST_ID` (2³¹), so a blob chunk always
  says whether it answers this side's ask or carries the peer's upload.
- **`hello`** carries `protocol`, `app` and `version`, `kind`, `os`,
  `name`, and `capabilities`; a device that serves also sends `server`
  and `macName`, which a shipped phone requires. Both sides send it, the
  initiator first. The old shapes (the phone's `{ protocol, app }`, the
  Mac's `{ protocol, server, macName }`) are still read, and mean a
  device that does not know groups. `PROTOCOL_VERSION` stays 1: a shipped
  Mac closes any other.
- **Both halves on each side.** Today the Mac's `PhoneSession` serves a
  phone and the phone's `RemoteClient` asks a Mac. A channel has both: a
  serving half (requests through `inject()` behind the allowlist, hub
  topics, blobs, files) and an asking half (requests, subscriptions,
  blob and file reads, uploads). A member without the `sessions`
  capability, the phone, answers every request with 404.
- **Roster messages** (`roster_digest`, `roster`, `removed`) travel in the
  channel, not as HTTP routes, so no allowlist entry can reach them.

## 6. What a member may call

- **One literal list for every member**, the phone included
  ([[every-member-reaches-one-literal-allowlist]]). It is today's phone
  list in `server/src/remote/allowlist.ts` plus what the federated
  Settings needs (settings, tag rules, harness templates, limits, stats,
  commands, files, `/api/dirs`). It stays a literal list: a new route is
  reachable from no device until someone adds it.
- **Not on it:** the IDE bridge and "open in editor" (they act on the
  other machine's screen), the dev tools, `/api/auth`, `/api/remote*` and
  `/api/devices*` (the group is changed by roster messages, not by a
  route), and the terminals (a pty is not an HTTP request; see
  `ideas/`).
- **Settings no member may change on another:** the `remote_*` settings
  (the relay is the group's, and set on a device only while it is alone,
  § 4). Everything else may be changed, as on the device itself
  ([[the-phone-may-do-what-the-mac-may]]) — `claude_executable_path` and
  the Claude directories included: a member that can start a session
  with `bypassPermissions` already runs whatever it likes there, so
  holding these back would protect nothing.
- Topics are checked the same way, by one list for every member.

## 7. What each device shows

- **A Mac and a server federate in their own server**, as in #79: the
  server subscribes to every member's `sessions` topic over its channel,
  republishes them into its own hub with `machine: { id, name, kind, os,
  online }`, and forwards a request for another member's session through
  that member's channel. The routing rules of #79's `preHandler` (a
  session path, `?session=`, `?machine=`, a body's `machine`), the tag
  mapping by name and the image fallback stay.
- **The phone federates on its own**: one asking half per member,
  merged as #79's `MultiClient` merges, with no "main Mac".
- **Nothing travels through a third device.** A device publishes to
  others only its own sessions; it ingests only sessions without
  `machine`; a request that came over a channel is never forwarded.
- **An offline member** keeps its last sessions with `online: false`; its
  composer is locked with "*name* is offline".
- **The UI** names devices, not Macs: "This device" / its name, "Add a
  device", device chips, "Filter by device". A device's kind and OS pick
  its label in the chip and the detail panel; no new colour, motion or
  sound ([[why-orbital]]).

## 8. Capabilities and versions

- `capabilities` lists what a device does: `sessions` (runs sessions),
  `map` (shows a map), `ide` (an IDE bridge on its screen),
  `folderPicker` (a native folder dialog), `presence` (can tell whether
  the user is at it).
- What a device offers for another member follows that member's
  capabilities and version: no folder picker on a server (the remote
  folder chooser over `/api/dirs` instead), no IDE bridge on anyone
  else's session. The phone's `MAC_FEATURES` (`mobile/CLAUDE.md`) becomes
  this check, per member.
- A member below the protocol this one needs is listed with "update
  Orbital on *name*" and its link stays closed.

## 9. Devices already out there

- **A phone without groups, a Mac with them.** The Mac serves it as
  today: it is a member of kind `phone` in the Mac's roster, which does
  not introduce it to other members (it could not take part). It joins
  the group fully at its next app update, with the key it has: no
  pairing again.
- **A phone with groups, a Mac without.** The Mac's `hello` names no
  groups; the phone keeps a one-to-one link with it, as today.
- **A relay without `/pair/mutual`** (§ 4).
- **#79 was never released**, so its second identities, `remote-peers.json`
  and `orbital.otherMacs` need no migration; they are not built.

## 10. Notifications

- A Mac notifies over its merged list, as #79 planned;
  `onlyWhenBackground` keeps two Macs at one desk from both chiming.
- Every member with `sessions` pushes a wake to the phone for its own
  sessions, as a Mac does today. Presence travels in the channel: while
  the user is at any member with `presence`, every member keeps the phone
  quiet (#88's rule, across the group). A server has no presence.

## 11. The headless server

Its own sub-project (§ 14), designed here only so far as the group needs
([[a-headless-orbital-is-a-full-member]]):

- The same server, `ORBITAL_HEADLESS=1`: no Electron, no static web app,
  kind `headless`, bound to `127.0.0.1` like every Orbital server.
- A full member: it runs sessions, federates (its sessions drive other
  members through the orbital MCP), and has no map.
- `orbital devices add|join|list|rename|remove` talks to the local server
  with the token in the data dir.
- The Linux fixes #79's spec listed: the bundled CLI resolved for the
  running platform (`server/src/runner/claudeCli.ts`), the harness verify
  command under `$SHELL` else `/bin/sh` (`server/src/harness/service.ts`),
  the data dir under `$XDG_DATA_HOME/orbital`, `better-sqlite3` built on
  install; a systemd unit and a runbook.

## 12. Phone

Built for the phone (§ 3, § 7): it is a member like any other, joins by
scanning any member's QR, adds a device by showing its own code, lists
every member in Settings → Devices, and reaches each member directly, so
a sleeping Mac takes away only its own sessions. It runs no sessions and
serves nothing. Against an older Mac it keeps today's one-to-one link
(§ 9), gated per member (§ 8). It ships over the air: one identity it
already has, no new plugin or permission.

## 13. Testing

- The roster merge: higher epoch wins, removal wins within an epoch, a
  stale member does not bring a removed one back, two groups merge.
- The relay's mutual pair: one half waits, both halves pair, a half
  expires, a revoked device's half is refused.
- The channel: both halves over one handshake; the initiator rule; the old
  `hello` shapes read as a device without groups.
- The allowlist: one list for every member; the denied set stays denied.
- One integration test: three servers and an in-memory relay; a device
  joins through one member and links with the third; a request and a
  topic both ways; removal from the third member closes every link.
- Against shipped apps: a phone without groups served by a Mac with them,
  and the reverse.

## 14. Sub-projects

1. **The channel**: one identity and one socket per device, both halves
   per channel, the new `hello` (`shared/`, `server/`, the phone's
   transport).

   As built (part 1): `POST /api/remote/join` joins another device
   without UI; the phone allowlist still governs what any member may
   call until part 3 (§ 6).
2. **The group**: the roster, joining through one member, the relay's
   mutual pair, removal, Settings → Devices on the Mac and the phone.

   As built (part 2a, no UI yet): the roster lives in its own table,
   `group_members`, not in `remote_devices` (§ 2 Storage) —
   `remote_devices` holds only the devices this one has a relay pair
   with. `POST /pair/mutual` and the `linked` control are as designed
   (§ 4); a relay that answers 404 (it predates the route) lists the
   other device `pairByHand` until the next relay `ok`. `/pair/mutual`
   and `/pair/revoke` draw on a per-IP budget of their own at the relay,
   so linking never locks a connect out; a rate-limited ask is retried
   on a timer. A removal made while the relay is offline is kept and its
   revoke posted at the next relay `ok`; every `ok` also asks again for
   the members paired here, so a pair the relay lost forms again. Removing
   this device's own id is leaving, refused offline. A leaving member
   marks the phones it paired removed, since their pairs go with it.
   Known limits: a device removed while it is offline learns of its
   removal only when it next talks to a member that already knows; a
   departed member that a sleeping peer missed stays live and unlinked
   there until someone removes it by hand — the relay's `unpaired` never
   changes the roster; removed entries are never pruned, so
   `ROSTER_MAX_ENTRIES` bounds a group's lifetime; and a device's `kind`
   and whether it links are its own word, so pairing anything by code
   trusts it group-wide (`docs/domains/device-group.md` → Known limits).
   As built (part 2b, desktop UI): Settings → Devices replaces Settings →
   Mobile (canvas 50a–50d, 50k). The pairing code is drawn only on a
   click (spec 2026-10-01). "In a group" — the relay and secret locked,
   a join from another group's device refused — counts only members that
   link or are not paired here: a desktop whose only other devices are its
   own phones keeps today's relay change and may join a desktop's group. A
   phone paired with another member reads "paired with <name>" (the relay
   reports presence only to a device's own pairs). The phone screens (50i,
   50j) are part 3.
3. **Federation over channels**: #79's `PeerService` and routing on the
   channel, the phone's merge, device chips and names, capabilities.

   As built (part 3a, the server): `docs/domains/device-federation.md`.
   The member allowlist adds what the desktop's detail panel and New
   session dialog call, and federated Settings' routes; a request a
   channel injects carries `x-orbital-device` and may not change a
   `remote_*` setting. "Too old" (§ 8) is a non-phone whose hello names
   no `group` — a Mac from before groups paired by its code; it is not
   federated, so the canvas's "reading still works" for it is not
   built. An offline member's sessions are kept in `member_snapshots`
   and survive a restart. Presence reaches every member over the
   channels' `presence` topic.
4. **The headless server** (§ 11), with its runbook.
5. **The orbital MCP on every member** (#93), on top of 3.

Each gets its own plan; 1–3 ship together.

## 15. Versions

Relay minor (`/pair/mutual`). Desktop minor. Phone app minor, no native
bump. The headless server is built from `server/` and carries the desktop
version.
