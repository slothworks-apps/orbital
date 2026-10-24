---
id: device-federation
title: Device federation — every member's sessions in this server, and requests through their channels
type: domain
status: in-force
domain: remote
related:
  - 2026-10-16-device-group-design
  - device-channel
  - device-group
  - every-member-reaches-one-literal-allowlist
  - 2026-10-24-group-shared-settings-design
  - group-settings-converge-by-last-change
tags:
  - remote
  - server
---
# Device federation

How a Mac or a headless server shows and drives the sessions of every
other member of its group (spec `2026-10-16-device-group-design` § 6–
§ 8, § 10; part 3a). The web app still talks only to its own server;
that server talks to the others over the channels of
`docs/domains/device-channel.md`, which the group of
`docs/domains/device-group.md` keeps linked.

## What a member may reach

One literal allowlist for every member, phone included
(`server/src/remote/allowlist.ts`, ADR
`every-member-reaches-one-literal-allowlist`): the phone's list, every
route the desktop calls about one session (so a session of another
device is driven from the detail panel as a local one), what a federated
Settings needs (settings, tags, tag rules, harness templates, limits,
stats, Claude directories) and `GET /api/dirs`. Never on it: the IDE
bridge, the dev tools, auth, the remote routes, presence, terminals, and
the two binary routes (`/api/images/:ref`, `/api/files/image`), which
travel as `blob_get`/`file_get` asks. A segment must match `SAFE_SEGMENT`,
so an MCP server whose name has a `.`, `:` or space is managed only on
its own device.

Topics: `memberMayWatch` in `servingHalf.ts`, one list for every member
(`sessions`, `errors`, `presence`, `limits`, and the per-session ones).
`limits` also follows the grant of `GET /api/limits` (`LIMITS_GRANT`):
without it a member's subscribe is refused and every `limits` frame to it
dropped.

Every request a channel injects carries `DEVICE_HEADER`
(`x-orbital-device`, the asking device's id, `inject.ts`). It only ever
restricts: such a request is never forwarded, gets no other member's
sessions merged in, may not change a `remote_*` setting (403) and reads
`GET /api/settings` without them. `/api/settings/shared` is the one route
that answers only such a request (below).

## FederationService

`server/src/federation/service.ts`, started after `RemoteService`. It
hears of every channel through `RemoteService.onChannel` and of every
roster or device change through `onStatus`.

**Who federates.** A live roster member that is not this device, not a
phone, and whose hello (the open channel's, else the last one kept by
`peerHello`) names `sessions` and `group`. A non-phone whose hello lacks
`group` — a Mac from before groups, paired through its code — is
`memberTooOld` (`server/src/remote/memberGate.ts`): Settings lists it
with `tooOld`, nothing is subscribed or asked of it.

**One link per member** (`MemberLink`): its sessions as it sent them,
its tags, the newest channel (an older one is ignored from then on),
`seenAt`, `present`. On the channel's hello it subscribes `sessions`,
`presence` (when the hello names it) and every per-session topic of that
member that has a local subscriber; on `ready` it seeds — `GET
/api/tags`, then `GET /api/sessions` with the first of `SEED_LIMITS` that
fits one frame — and upserts every session that is new or changed; a
member that was shown offline comes back online in one `machine` event.
A list that cannot be read (a non-200, a channel failure, every limit
too large) leaves the member's sessions offline, as of the last list
read, and the seed is asked again after `SEED_RETRY_MS`, doubling up to
`SEED_RETRY_MAX_MS`, while the channel stays up. A hub frame from the
member: a `sessions` upsert, remove or status is republished (an upsert
that carries `machine` is dropped — no chaining); `presence` sets
`present` and is never republished; any other topic only when it is
about one of that member's own sessions.

**What a member may claim** (`mayHold`, at seed, upsert, restore and
in a member's list): a session id that is a safe path segment, held
neither by this device nor by another member; at most
`MEMBER_SESSIONS_MAX` per member (past it a new id is dropped and logged
once). The web app encodes every value it puts in an `/api` path as one
segment (`web/src/lib/api.ts`), so an id a member chose never reaches
another route. A channel download stops at the size the peer announced
(`DOWNLOAD_MAX_BYTES` when it announced none) and at an overall
deadline.

**What a federated session looks like.** The member's session with its
tags mapped by name to this server's tag ids, and
`machine: { id, name, kind, os, online, asOf }` from the roster entry;
`asOf` is when the member was last heard from while it is offline, null
while online. `MachineRef` lives in `shared/src/remote/device.ts`. A
change of the member's state alone — online, offline, renamed — is one
`sessions` event `{ event: 'machine', machine }` that the web store
applies to every session with that `machine.id`; `ServingHalf` withholds
it from every peer and `DeviceWatcher` ignores it.

**Offline.** When the channel stops being ready the member's sessions
are marked `online: false` (one `machine` event) and stay. They survive a restart:
each link is written to `member_snapshots` (`server/src/federation/store.ts`)
at most once per `SNAPSHOT_WRITE_MS` while changes come — a change of a
session's `status` or `lastAt` alone schedules none — at once when it
goes offline, and at `stop()`; `start()` restores the snapshots of live
members, offline. A snapshot keeps at most the first `SEED_LIMITS`
sessions, the newest.

**Removal and leaving.** A member that leaves the roster is dropped: a
`remove` for each of its sessions, its subscriptions undone, its
snapshot deleted. When every other live member is a phone (this device
left, or was removed), every link and every snapshot row goes. A
`remove` is always published before the session is forgotten, so the
serving-side filter below still knows it was another member's.

## Requests for another member

`server/src/federation/routes.ts`, a `preHandler` registered before the
routes (the token guard is an `onRequest` hook and runs first):

- The member is the one holding the session of the path
  (`/api/sessions/:id…`, `/api/stats/sessions/:id…`, never a literal
  sibling in `RESERVED_SEGMENTS`), else of `?session=`, else the
  `machine` of the query or the JSON body. `machine` = this device's
  own id falls through to the local route; an id that is neither 404
  `unknown_device`.
- The request goes through `federation.request` with `machine` dropped;
  a member's 401 reaches the window as 502 `member_refused` (only this
  server's own 401 means the token is wrong), and an answer naming a
  session other than the one asked for has that session dropped;
  a composer's attachments are first sent to the member's image store
  (`putBlob`), a spawn's `tagId` and a tags `PUT` are mapped to the
  member's tags of the same names (made there when missing). An offline
  member answers 409 `member_offline`, a broken channel 502
  `member_unreachable`.
- `GET /api/files/image?session=` goes through `getFile`;
  `GET /api/images/:ref` not on disk here is asked of every member, one
  after another, until one answers bytes that hash to the ref.
- A multipart upload is stored here, also for a member's session
  (`foreign` on the attachments route), and sent on with the message —
  an image only: anything else would reach the member as a path on this
  machine, so it is refused with 422 `attachment_not_on_device`.
- `?sessionId=` (harness templates) is routed like `?session=`.
- A spawn sent to a member subscribes that member's channel to the new
  id's topics before it is forwarded, so the session's first frames are
  not lost before the member lists it.
- A request that came over a channel and names another device
  (`machine` in its query or body) is refused with 400 `not_forwarded`,
  rather than run here.
- `GET /api/sessions?machine=<self>` is this device's own list, nothing
  merged; `?machine=<member>` is that member's list, localized.
- The image fallback answers with the type of the ref's extension,
  `nosniff`, and only bytes whose sha256 is the ref's.

**Reading an offline member.** Every forwarded `GET` about a member's
session that answers 200 is kept in memory by its exact url
(`READ_CACHE_MAX_BYTES` in all, least recently used out first; an answer
over `READ_CACHE_ENTRY_MAX_BYTES` is not kept). While that member is
offline the copy is served, 200 with `x-orbital-as-of: <ms>`; a url never
read while it was up still answers 409. A restart forgets the copies
(the snapshot keeps only the list); a member dropped, or a session
removed, takes its copies with it.

`GET /api/sessions` (first page, no `DEVICE_HEADER`, not itself
forwarded) gets every member's sessions appended, filtered as the route
filters its own: harness drafts, `source`, `q`, `tag`, `ended`.

## No chaining on the serving side

Federated sessions live in this server's hub, and two readers of that
hub act for another device. `ServingHalf` withholds from a peer every
`sessions` frame of a session that carries `machine` or is `foreign`
(`federation.linkOf(id) !== null`), and ignores a subscribe to a
per-session topic of a foreign session. `DeviceWatcher` wakes a phone
only for this device's own sessions — every member pushes for its own
(spec § 10).

## Presence across the group

A member whose hello names `presence` is subscribed to its `presence`
topic; `presentElsewhere()` is true while one is present and its channel
is ready. A phone's watcher stays quiet while the user is at this device
or at any such member (`groupPresence` in `RemoteServiceOptions`). What
this server answers a peer's own `presence` subscription is its own
presence only.

## Limits across the group

Spec `2026-10-20-limit-suns-design` § 1. While a window of this device
watches `limits` — the hub's `onFirstLocalSubscriber`, which does not
count a paired device's view of the hub (`Socket.peer`, set by
`ServingHalf`) — every member's `limits` topic is subscribed to and
`GET /api/limits` read once per ready channel, and again every
`LIMITS_REFRESH_INTERVAL_MS` while the watch lasts: a peer's watch does
not start a member's own interval probe, and the read is what lets an
idle member refresh an old answer. Each member's last
directories are kept in memory (`MemberLink.limits`), an offline
member's too, and `LimitsService.snapshot` appends them to this
device's own through `memberLimitsEntries` (`shared/src/limits.ts`),
tagged with `machine`, stale and without an estimate while the member is
offline. A read of a member's limits never rejects; a failure that is not
the channel's is logged. `POST /api/limits/refresh` asks every live member
as well. A request with `DEVICE_HEADER` gets this device's directories
only, and `ServingHalf` strips every directory carrying `machine` from a
`limits` frame to a peer. A member watching this device's limits neither
makes it probe on its interval (`LimitsService.watch` follows
`onFirstLocalSubscriber` too) nor is asked on to the others: it gets the
reads that happen here anyway — the background reading, a session's
`rate_limit_event`, and its own `GET /api/limits`, which reads an old
answer again.

## Settings the group shares

Spec `2026-10-24-group-shared-settings-design`, ADR
`group-settings-converge-by-last-change`; `server/src/settings/sharedSettings.ts`.

**Which.** `SHARED_SETTING_KEYS` in `shared/src/sharedSettings.ts`; every
other key stays on its device. `PER_DEVICE_SETTING_KEYS` (and the `remote_`
and `new_session_last_` prefixes) name the rest, and a test fails on a seeded
key in neither list.

**Stamps.** Each `settings` row carries `stamp_at` and `stamp_origin`
(migration `0034_group_shared_settings`): when the value was set and on
which device, an empty origin meaning this one. A seeded default and every
row from before the migration is at 0. A `PATCH /api/settings` that changes
a shared key's value stamps it now (`SharedSettingsSync.changedLocally`),
also when the PATCH came from a member's federated Settings; one that saves
the same value stamps nothing. One stamp beats another by `stampBeats`: the
later time, then the group's primary as origin, then the higher origin id.

**The route.** `GET /api/settings/shared` lists every shared key this
device holds with its value and stamp; `POST` takes some. Both are on the
allowlist under the `settings` grant and answer only a request whose
`DEVICE_HEADER` names a live roster member that is not a phone, not this
device, and holds the `settings` grant here (`partner`); anyone else, the
local app and a phone included, gets 403 `not_a_member`. A stamp later than
this device's clock plus `SETTINGS_STAMP_SKEW_MS` is clamped to it.

**Push and catch-up.** A member shares when its hello names
`settings-sync` (`capabilitiesOf` gives it to a desktop and a headless
server). After a local change the changed keys go to every live partner
that shares, over a ready channel. Once per ready channel to such a
partner, this device reads its list; a list refused with `not_a_member`
(the partner has not yet taken the roster that names this device) is asked
again at the next status change. Every value whose stamp beats this
device's own, or that this device holds no row of, is taken with its stamp
unchanged; nothing taken is forwarded. When a taken value differs from the
one held, the same side effects as a PATCH run (`settingsChangedEffects`:
the limits waits, the branch status) and the local hub topic `settings`
carries `{ event: 'changed', settings }`. That topic is not in
`memberMayWatch`, and a local PATCH does not publish it (the window that
saved already holds the value). The web store merges it, and the window
sends the desktop's `settings-changed` IPC so the main process re-reads.

**Joining.** `GroupMembershipStore.set` sets every shared stamp to -1 in the
transaction that records a membership of a group this device did not found,
of a founding it was not in (`joinsGroup`): taking the primary's first
roster after a ceremony. Every value already in the group then beats this
device's own. Founding, a later version of the same group and leaving reset
nothing.

**A member too old** (no `settings-sync`) is neither pushed to nor read.
**The phone** reads `GET /api/settings` from a member that shares
(`docs/domains/phone-in-the-group.md`).

## Known limits

- The `ended=exclude` fold count adds every folded session of every
  member, while this device's own count is one page's.
- Other members' sessions are appended after the local page; the web app
  sorts them itself.
- A session id present on two devices (one `~/.claude` copied to
  another machine) is routed to the first member that lists it.
- A seed racing a frame of the same channel is inherited from #79: the
  next upsert corrects it.
