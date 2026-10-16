---
id: 2026-10-06-peer-macs-design
title: Peer Macs — one map over the sessions of every paired Mac
status: active
type: spec
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - peer-macs-federate-through-the-local-server
  - the-phone-tunnels-the-api-behind-an-allowlist
  - remote-identity-is-ed25519-with-ephemeral-session-keys
  - hand-a-session-to-another-mac
  - a-headless-orbital-is-a-peer
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
| a Linux server (VPS) | a headless peer: host only, paired from the terminal (§ 5, [[a-headless-orbital-is-a-peer]]) |

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

Decided after the first cut: **the phone pairs with every Mac itself**, so
a Mac that sleeps takes only its own sessions away, not the others'.

- **One main Mac, any number of others.** The first pairing stays what it
  is today: every screen about "the Mac" (asleep, unpaired, too old, the
  app lock, "Pair a different Mac") is about it. Settings → Macs adds
  another Mac by the same scan and code; each one gets its own identity
  in secure storage, since the relay holds one socket per device.
- **One client in front of them all.** `MultiClient` sits behind
  `clientRef` and routes the way the Mac's `preHandler` does (§ 8): a
  session's requests, topics, files and `seen` go to the Mac that listed
  it; `?machine=` and a spawn's `machine` pick a Mac; the rest goes to the
  main Mac. Images are uploaded to the session's Mac (to every Mac that
  is up when there is no session yet), stored images are asked of each.
- **Lists merge on the phone.** `GET /api/sessions` asks every Mac that is
  up; another Mac's sessions get `machine` and the main Mac's tag ids by
  name, as a Mac does for its peers. A session the phone reaches directly
  wins over the same session passed on by another Mac; a Mac it reaches
  only through another still shows. A Mac whose tunnel comes up is listed
  again, one that goes down keeps its sessions with `machine.online` false.
- **What the user sees.** With two or more Macs the session rows name
  their Mac, the list has a chip per Mac, and New session a Mac picker.
- **Against older Macs.** Nothing on a Mac changes for this: the phone
  merges on its own, so no `MAC_FEATURES` row.

## 5. A headless Linux peer

An always-on machine does not have to be a Mac. A Linux VPS runs the same
server without Electron and without the web app, and joins as a peer
that is **host only**: Macs see and drive its sessions, it sees nobody's.

- **Running it.** `node server/dist/index.mjs` with `ORBITAL_HEADLESS=1`,
  under a systemd unit the runbook gives. Headless means: no static web
  app, no client role, no peer subscriptions, no native notifications.
  The server still binds to `127.0.0.1` only; nothing on the VPS listens
  publicly. Its web UI is not part of v1 — the Mac's map is the UI.
- **Linux fixes the server needs anyway:**
  - the bundled CLI is resolved from the SDK package of the running
    platform, not a hard-coded `claude-agent-sdk-darwin-arm64`
    (`server/src/runner/claudeCli.ts`);
  - the harness verify command runs under `$SHELL`, falling back to
    `/bin/sh`, not a hard-coded `/bin/zsh` (`server/src/harness/service.ts`);
  - the data dir defaults to `$XDG_DATA_HOME/orbital` (else
    `~/.local/share/orbital`) on Linux, not `~/Library/Application
    Support` (`server/src/config.ts`);
  - `better-sqlite3` is built by `npm install` on the VPS; nothing is
    shipped prebuilt.
- **Pairing from the terminal.** The VPS is always side A of the
  ceremony (§ 1):
  1. `orbital pair` on the VPS prints the pairing code and waits.
  2. The Mac pastes it under Settings → Devices → "Pair a Mac", as for a
     Mac.
  3. The VPS prints the Mac's fingerprint and asks y/n.
  4. Step 4 of § 1 is skipped: the VPS has no client role, so the Mac
     sends no offer back. The Mac's chip for it works; the VPS has none.

  `orbital devices` lists and `orbital unpair <name>` removes paired
  devices. A phone does not pair with the VPS: it sees the VPS's
  sessions through its Mac (§ 4).
- **Claude login.** `claude /login` on the VPS, which prints a URL and
  takes the code back in the terminal. The CLI keeps the login in
  `~/.claude/.credentials.json` on Linux.
- **The Mac's side.** A peer with `platform: 'linux'` is the same peer.
  Settings sections that belong to a machine show the VPS's settings, so
  tag rules and limits on the VPS are edited from the Mac. Spawn on it
  uses the remote folder chooser (`/api/dirs`).
- **Nothing on the VPS needs macOS features.** The IDE bridge and "open in
  editor" are already hidden for a peer's session (§ 3).

## 6. Testing

Worth testing, per the repo's rule:

- the registry and routing: local, peer, unknown and offline sessions;
  `?machine=` on machine-scoped routes
- the peer allowlist versus the phone's, through `allowedPath`
- no chaining: a peer's request for a third Mac's session is refused
- tag merging by name and the colour rule
- the pairing ceremony in both directions, and unpairing from either side
- one integration test: two servers through an in-memory relay, a spawn
  on the peer, a message, a decision, the merged list updating
- a headless host refuses a pairing offer and opens no peer
  subscriptions; the CLI path and the data dir resolve per platform

## 7. Phases

1. Pair two Macs; merged list and chips, read-only.
2. Drive a peer's session: composer, decisions, files, diffs, harness,
   MCP, rewind, walkthrough.
3. Spawn on a peer, with the remote folder chooser.
4. A peer's settings, and the phone.
5. The headless Linux peer (§ 5), with its runbook.

Versions: desktop minor; mobile minor in phase 4; relay unchanged. The
headless server is built from `server/` and carries the desktop version.

## 8. As built (first cut)

Phases 1–3 and the phone's reading side of phase 4, in one change. Where
the build differs from the sections above:

- **Peers live in a file, not a table.** `remote-peers.json` in the data
  dir (mode 0600) holds each peer's relay, name and this Mac's client
  identity for it, beside `remote-identity.json`. No migration.
- **The pairing code is the QR's JSON as one base64url word**
  (`POST /api/peers/code`); the other Mac pastes it (`POST /api/peers/pair`)
  and shows the code to type on the first one, whose existing pending-pair
  dialog takes it as it does a phone's. The reverse direction is
  `POST /api/peers/offer` through the new tunnel, accepted without a code
  because the remote marked its own code `auto`.
- **This Mac's sessions carry no `machine`.** A peer's sessions carry
  `machine: { id, name, online }`. A Mac ingests only sessions without it,
  and `PhoneSession` in peer mode drops frames with it — that is the whole
  no-chaining rule on the wire. A call a peer makes carries
  `x-orbital-peer` into `inject` and is never forwarded.
- **The list merges on its first page.** `GET /api/sessions` without an
  offset appends every peer's sessions (filtered by `q`, `tag` and
  `ended` as the route filters its own). A peer is read with
  `limit=200`, then 80, then 30 while its answer is too large for one frame.
- **Routing is one `preHandler`** (`server/src/peers/routes.ts`): a
  `/api/sessions/:id` or `/api/stats/sessions/:id` path, a `?session=`,
  a `?machine=` or a body's `machine` picks the peer. `/api/images/:ref`
  falls back to the peers when the image is not stored here, and
  `/api/files/image` goes through `file_get`.
- **Composer images** are uploaded to this Mac as for its own sessions, and put into the peer's store (`blob_put`) before
  the message that names them; file attachments do not reach a peer yet.
- **Tags** are matched by name both ways; tagging a peer's session with a
  tag it lacks creates it there.
- **A phone paired with one Mac** reaches the others through it: the
  Mac's list carries them, its requests are forwarded like the web's, and
  its `blob_get` and `file_get` for a peer's session are answered through
  the Mac. § 4 pairs it with each Mac directly on top of that.

- **What a paired Mac may not do**, on top of the routes it cannot reach:
  change `claude_executable_path` or any `remote_*` setting (a path to any
  program, the relay itself), open or drive a terminal, or make this Mac
  pair with some Mac of its choosing — `POST /api/peers/offer` is taken only
  from a paired Mac's tunnel and only within two minutes of a Mac pairing
  as this one's client. Beyond that a paired Mac has full parity by design:
  pairing a Mac trusts it as much as sitting at this one.

Not built yet: unpairing both directions from one side (forgetting a Mac
removes only this Mac's client of it; the other Mac lists this one under
its devices until revoked there), the remote folder chooser
(`GET /api/dirs`), the machine switch in Settings, and the headless Linux peer (§ 5).

## 9. The orbital MCP on every paired Mac

Agreed after the first cut: a session drives every paired Mac through the
`orbital` MCP server as fully as its own, so one session can spawn,
read and message sessions on another Mac. Built once
`2026-10-13-orbital-controls-itself-design` (PRs #75, #84) is on `main`:

- Its tools enter the server through `app.inject` without the peer header,
  so § 8's routing already sends an operation on another Mac's session to
  that Mac: reading a transcript, sending a message, answering a card.
- `orbital_read`, `orbital_act` and `spawn_session` take an optional
  `machine` (a peer id); an operation without a session goes to that Mac
  as `?machine=`, a spawn as the body's `machine`.
- One more read operation lists the paired Macs and whether each is up
  (`GET /api/peers`), so a session can name one.
- As built: `list_macs` in the catalog; `onMachine` in
  `server/src/runner/controlTools.ts` puts `machine` where the routing looks;
  `spawn_session` with `machine` posts the spawn to that Mac
  (`spawnOnPeer`), which checks the directory — a `cwd` is then required —
  and keeps the session. The child takes the parent's permission mode and
  model; it is not tagged and not recorded as spawned by the parent, which
  lives on another Mac.
- The refusals stay as they are on the Mac that runs the operation: the
  peer's own allowlist (§ 1) still keeps pairing and dev routes away, and
  an operation that would stop the calling session's turn is refused only
  for the caller's own session.
