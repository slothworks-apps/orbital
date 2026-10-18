---
id: phone-in-the-group
title: The phone in the device group — one socket, a channel per member, its own federation
type: domain
status: in-force
domain: remote
related:
  - 2026-10-16-device-group-design
  - device-channel
  - device-group
  - device-federation
  - the-relay-answers-cors-for-redeem
tags:
  - remote
  - mobile
  - relay
---
# The phone in the device group

How the phone takes part in its group today (spec
`2026-10-16-device-group-design` § 5, § 7, § 9, § 12; part 3c). It is a
member like a Mac or a server, except that it runs no sessions and serves
nothing: it reaches every member directly, so a sleeping Mac takes away
only its own sessions.

## One code for the member logic

The member logic the server built in part 2a lives in `shared/` and runs
on both:

| piece | file | what it holds |
|---|---|---|
| `GroupMember` | `shared/src/remote/group.ts` | the roster writes and their sync over channels, linking through `/pair/mutual` (asked once per relay connection, 404 → pair by hand, 429 → retried after `MUTUAL_RETRY_MS`), `linked`, removal, leaving, pending revokes, the member rows Settings lists |
| `PairingCeremony` | `shared/src/remote/ceremony.ts` | showing a code (`/pair/token`, the proof check, `PAIR_CODE_ATTEMPTS`, confirm) and joining by one (`/pair/redeem`, the code to type on the other device, cancel) |
| `RelayLink` | `shared/src/remote/relayLink.ts` | the phone's relay socket on its own: auth, reconnect, push token, every control, frames by peer, signed `post` |

`RemoteService` (`server/src/remote/service.ts`) hosts the first two over
its SQLite stores; the phone's `GroupClient` hosts them over an in-memory
`MemoryGroupStorage` it persists behind. Roster entries are signed (ADR
`roster-entries-are-signed`, `docs/domains/device-group.md`); a stored
roster without signatures is dropped and learned again from the members.
A device that joins writes nothing for the device it joined: it takes
that device's entry from its first roster.

## `GroupClient`

`shared/src/remote/groupClient.ts`. One `RelayLink`, one `GroupMember`,
one `PairingCeremony`, a `Channel` per paired device. The phone always
initiates; its hello names `kind: 'phone'` and the `group` capability
(`GROUP_PHONE_CAPABILITIES`), which is what makes the other members link
with it and send it roster messages. `capabilitiesOf('phone')` stays `[]`
for `RemoteClient`, which now only stands in for a shipped phone in
tests.

- **Channels** open for every paired peer the relay reports online, at
  `presence`, and when the group links a new member. A peer that goes
  offline drops its channel. A channel that goes silent while no other
  peer has spoken rebuilds the whole socket — a half-open socket is the
  likely cause, as for a shipped phone.
- **The relay's word** changes pairs, never the roster: `unpaired` and a
  paired row missing from `ok.pairs` drop that pair and channel. A relay
  `error` `not_paired` or `unknown_device`, or a refused secret, does not
  forget a phone that holds a group: it reads as `pairs_lost` below. Only
  a phone with no group forgets on it, as a shipped phone did.
- **`unpaired_all`** fires when the roster says this phone is no longer
  in a group (removed by a member). The app shows 9h.
- **`pairs_lost`** is the relay losing pairs while the group still
  holds the phone: the members re-form them through `/pair/mutual`.
  When no pair and no channel come back within `ALONE_GRACE_MS`, the
  client marks itself `unreachable` and the list shows one card, "No
  device in your group can reach this phone right now", with Pair again.
  Nothing is forgotten on that path: a relay reset while every member
  sleeps must not wipe the phone.
- **An old relay** (announcing a version below
  `RELAY_PHONE_GROUP_VERSION`, or none): a post the WebView cannot make
  (no CORS) reads as a relay without the route — the member is listed
  "pair by hand", and showing this phone's code says the relay needs an
  update.

## `GroupFederation`

`web/src/mobile/transport/groupFederation.ts` implements the one
`SwappableClient` every seam of the app holds (`tunnelFetch`,
`TunnelSocket`, the image resolver, `tunnelUpload`), over every member
that serves sessions — a group member, or a shipped Mac by its `server`
hello. #79's `MultiClient`, with no main Mac:

- Every session carries `machine`; a session that already carries one
  (a member passing on a third's) is dropped, and so is one whose id
  another member already holds (`mayOwn`).
- An image asked of every member is taken from the first whose bytes
  hash to the ref; a wrong answer moves on to the next. A thumbnail
  cannot be checked that way, so it is never written to the file cache;
  a cached full image stands in for it offline.
- A request about a session goes to its owner. An owner not known yet is
  looked up — the relists in flight are waited for (bounded), then every
  ready member is asked — never sent to the default member. A request
  naming `machine` goes there; anything else to the default member (the
  last one a session was started on, else the first ready one). The
  first owner keeps a session while it is ready.
- Lists are merged across members; an offline member's last sessions
  stay, `online: false`, told in one `machine` event as on the Mac
  (`docs/domains/device-federation.md`). A relist that fails on the
  channel is logged, naming the member, and tried once more after
  `RELIST_RETRY_MS`. Tags share one namespace by name, mapped both
  ways (tags, tag rules, a spawn's tag).
- Presence is aggregated: one `presence` frame, at the user while they
  are at any member. Notification settings are the phone's choice and
  reach every member as it links (a phone migrated from one Mac adopts
  that Mac's rules once). A member's first list after it comes back
  seeds the notifier: it already pushed a wake for what changed while
  it was away.

## The app

- **Storage** (`web/src/mobile/platform/group.ts`): `orbital.group` holds
  the relay, its secret and the stored group, written through a
  one-at-a-time queue. A phone paired before groups is migrated from
  `orbital.pairing` without pairing again. `orbital.pairing` keeps being
  written with the first paired device (the native shells read its
  presence for the app lock's snapshot cover) and decides when the two
  disagree after an over-the-air rollback.
- **State** (`state.ts`): `devices` (each source's online, ready, as-of,
  version, capabilities) and `members` (the roster rows). One member's
  `bye app_too_old` marks only that device; 9i only when every source
  refuses. `MAC_FEATURES` is checked per device (`deviceSupports`,
  `sessionSupports`).
- **Screens:** Settings → Devices (canvas 50i), this phone's code, the
  join request sheet (only behind no lock; a tap beside it or back sets
  the request aside, Settings → Devices brings it back, only Reject
  rejects), the newcomer's "Type
  <code> on <name>"; the list's device chips, asleep per device, rows
  naming their device, New session's device picker (canvas 50j). A
  too-old device's sessions are read only.
- **Leaving** keeps the identity; it is refused while the relay is
  offline, where "Forget this group on this phone" forgets it locally.
  Removing the last other member is leaving. A removal by the group
  clears the identity, as it always did.

## The relay

`ok` names every pair (`pairs`), not only the online ones. Every signed
pair route answers CORS (ADR `the-relay-answers-cors-for-redeem`,
amended). `/pair/token` keeps a known device's kind. `/pair/redeem`
checks the code's device is online before it uses the code, so a 409
`peer_offline` leaves it good until it expires.

## Known limits

- The server's `RelayClient` and the phone's `RelayLink` are two
  implementations of the same relay protocol; a fix to one does not
  reach the other.
- A desktop may pair several phones; the phones of one group never link
  with each other (both would open the channel), and each lists the
  other as paired with the desktop it joined through.
