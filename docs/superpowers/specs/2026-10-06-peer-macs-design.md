---
id: 2026-10-06-peer-macs-design
title: Peer Macs — one map over the sessions of every paired Mac
status: draft
type: spec
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - peer-macs-federate-through-the-local-server
  - the-phone-tunnels-the-api-behind-an-allowlist
  - remote-identity-is-ed25519-with-ephemeral-session-keys
  - hand-a-session-to-another-mac
tags:
  - remote
  - relay
  - server
  - web
---
# Peer Macs

## Problem

One person, two Macs: one stays at home and is always on, the other
travels and is often closed. Work started on the laptop stops when its
lid shuts. Work started on the home Mac keeps going, but today it can be
driven only from that Mac or from the phone. The laptop should be able
to start sessions on the home Mac, drive them with everything Orbital
offers, and show them on the same map as its own sessions — and the home
Mac should see the laptop's sessions while the laptop is open.

## Decisions taken while brainstorming

| question | decision |
|---|---|
| how the map shows two machines | one map with every machine's sessions; machine chips in the header filter it (multiselect) |
| direction | symmetric: every paired Mac is host and client of the other |
| what works on a peer's session | full parity: everything the local app does, including the peer's settings, except the IDE bridge and dev tools |
| where federation lives | in the local server, over the existing relay ([[peer-macs-federate-through-the-local-server]]) |
| relay changes | none; a Mac's client role is a phone to the relay |

Ruled out: federation in the renderer (identity in the renderer, every
web client pairs on its own, notifications bypass the server) and a
direct Tailscale/LAN link (breaks the `127.0.0.1`-only binding and the
relay's trust model; a possible later optimisation, not the base).

Out of scope: handing a session and its working tree to another Mac
([[hand-a-session-to-another-mac]]); more than two Macs in the UI (the
model is N, only two are tested); a LAN shortcut; waking a sleeping Mac.

## 1. Pairing and transport

- **The relay does not change.** A Mac's client role has its own second
  Ed25519 identity in the data dir and registers with the relay as
  `kind: 'phone'`, `platform: 'macos'`. One client identity per peer.
  The relay version is not bumped.
- **The host picks the allowlist by platform.** `remote_devices.platform`
  is `macos` for a peer. A peer's `http` frame passes a second literal
  list in `server/src/remote/allowlist.ts` with every route except the
  IDE bridge (`/api/sessions/:id/ide/*`), `/api/dev/*` and `/api/remote*`
  (pairing stays local). The phone's list is unchanged. The same
  canonical-path check applies to both lists.
- **One ceremony, both directions.**
  1. Mac A, Settings → Devices → "Pair a Mac", shows a pairing code: the
     QR's payload (relay URL, public key, token, one-time secret, relay
     secret) as copyable text. A laptop camera is not a scanner.
  2. Mac B pastes it. B redeems as a client, exactly as a phone does.
  3. A shows the fingerprint; the user confirms on A. B is now A's client.
  4. B, over the now-authenticated channel, sends a pairing offer for
     its own host identity; A redeems it and B accepts it without a
     second fingerprint. The user has already consented on both Macs and
     the offer arrived inside a channel whose key the user confirmed.
- **Unpairing** on either side revokes both directions: the side that
  revokes sends `peer_unpair` before revoking its own pair.
- **Connections.** The server keeps one client WebSocket to the relay
  per peer, with the reconnect and watchdog the host side already has.
  Relay presence gives online/offline.
- **Versions.** The first frame carries the protocol version. A peer
  that is too old is refused with "update Orbital on <name>" on its chip.

## 2. Server: federation and routing

New module `server/src/peers/`.

- **Session → machine registry.** The local server subscribes to every
  peer's `sessions` topic and keeps `sessionId → machineId`. Session ids
  are UUIDs; a collision is not handled.
- **Merged `sessions` topic.** The local hub publishes local sessions
  plus every peer's, each with `machine: { id, name }` (`id: 'local'` for
  this Mac). A peer that goes offline keeps its last snapshot in the
  list, flagged `machineOnline: false`, so the map does not jump.
- **Transparent routing.** A request to `/api/sessions/:id/...` whose
  session belongs to a peer is forwarded through the tunnel and served
  there by `inject()`. Web call sites for a session do not change.
- **Per-session topics.** `session:<id>` of a peer's session is
  subscribed through the tunnel only while someone subscribes locally,
  and republished into the local hub.
- **Machine-scoped routes** (`/api/projects`, `/api/models`,
  `/api/commands*`, `/api/files*`, `/api/settings`, `/api/tags*`,
  `/api/tag-rules*`, `/api/harness/*`, `/api/stats/*`, `/api/limits*`,
  `/api/errors*`, `/api/sessions/defaults`) take an optional
  `?machine=<id>`; without it they answer for this Mac. Spawn
  (`POST /api/sessions`) takes `machine` in its body.
- **A new route lists a directory** on a machine, for the remote folder
  chooser (§ 3): `GET /api/dirs?path=` returning subdirectories only,
  under the user's home.
- **Binary** (images, attachments) goes through the tunnel's existing
  64 KB chunking.
- **No chaining.** A Mac forwards only requests for its own sessions and
  publishes only its own sessions to peers. What A knows from B never
  travels on to C, and a peer's merged list never contains a third Mac.
- **Errors.** A tunnel that drops mid-request answers 502
  `peer_unreachable`; a request to an offline peer answers 409
  `peer_offline`. Both reach the error surface like any failed action.

## 3. Web: map, chips, spawn, tags

- **Machine chips** sit in the map header, shown only when at least one
  peer exists. Multiselect, all on by default, remembered across
  restarts. An offline machine's chip is dimmed and says "offline"; an
  incompatible one says "update".
- **A peer's planets** look like local ones. The machine name appears in
  the label and the detail panel only while two or more chips are on. No
  new colour, motion or sound ([[why-orbital]]). A session of an offline
  machine keeps its last state and its composer is disabled with
  "<name> is offline".
- **Tags merge by name.** Clusters form by tag name, so "orbital" on both
  Macs is one cluster; on a colour conflict the local tag's colour wins.
  Tagging a peer's session uses the peer's tag of that name, created
  there if missing.
- **New session** gets a machine picker, defaulting to the last one used.
  For a peer, the native folder picker is replaced by a chooser over
  `/api/projects?machine=` and `/api/dirs?machine=`.
- **Settings.** Sections that belong to a machine (general, tag rules,
  harness templates, limits) get a machine switch at the top. Settings →
  Devices lists phones and peer Macs and holds the pairing.
- **The IDE bridge and "open in editor"** are hidden on a peer's
  session: they would act on the other Mac's screen. The file viewer and
  diffs work through the tunnel.
- **Notifications.** The desktop notifies over the merged list, so a
  peer's session that needs input notifies here too. Sitting at both
  Macs means both notify, as a Mac and its phone do today;
  `onlyWhenBackground` already damps it.

## 4. The phone

The phone reaches peer Macs through its own Mac and needs no pairing of
its own: the merged `sessions` list and transparent routing carry a
peer's sessions to it over the routes it already calls, and the phone's
allowlist is applied on its Mac before anything is forwarded. Changes on
the phone: a session row shows the machine name when there are two or
more machines, and New session gets a machine picker. No chips on the
phone in v1; the list is enough. Recommended pairing: the phone with the
Mac that is always on.

## 5. Testing

Worth testing, per the repo's rule:

- the registry and routing: local, peer, unknown and offline sessions;
  `?machine=` on machine-scoped routes
- the peer allowlist versus the phone's, through `allowedPath`
- no chaining: a peer's request for a third Mac's session is refused
- tag merging by name and the colour rule
- the pairing ceremony in both directions, and unpairing from either side
- one integration test: two servers through an in-memory relay, a spawn
  on the peer, a message, a decision, the merged list updating

## 6. Phases

1. Pair two Macs; merged list and chips, read-only.
2. Drive a peer's session: composer, decisions, files, diffs, harness,
   MCP, rewind, walkthrough.
3. Spawn on a peer, with the remote folder chooser.
4. A peer's settings, and the phone.

Versions: desktop minor; mobile minor in phase 4; relay unchanged.
