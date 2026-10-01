---
id: 2026-09-30-mobile-remote-design
title: Mobile remote — a phone client over an end-to-end encrypted relay
status: active
type: spec
domain: remote
related:
  - mirror-sessions-to-claude-ai
  - api-token-guards-the-local-port
  - 2026-09-22-desktop-background-mode-design
  - 2026-09-22-ws-reconnect-resync-design
  - 2026-09-18-transcript-images-design
  - 2026-09-16-electron-wrapper-design
  - 2026-10-01-mobile-remote-backend
  - remote-identity-is-ed25519-with-ephemeral-session-keys
  - the-phone-tunnels-the-api-behind-an-allowlist
tags:
  - mobile
  - relay
  - security
  - server
---
# Mobile remote

**Status: active.** Brainstormed 2026-09-30 as a non-binding idea, then
built: [[2026-10-01-mobile-remote-backend]] implements everything below
except the phone itself — `shared/` (the wire protocol), `relay/` and
`server/src/remote/` are done and reviewed. § 1's key handling is amended
from what was brainstormed here; see the note at its head. What remains
is the phone client (§ 4) and the Mac-side pairing screens on the canvas.

Canvas: `Feature - Mobile.dc.html` (artboards 9a–9g, parts and states in
9p), drawn 2026-10-01. It covers the phone only; the Mac-side screens
(Settings → Mobile: pairing QR, the fingerprint confirmation, the device
list) are not drawn yet and have to be before implementation.

## Problem

A session lives on one Mac, and the person who launched it has to sit at
that Mac to see what it is doing, answer its questions, or start the next
one. Claude's own Remote Control answers this for the CLI, but only for what
the Claude app can show: no map, no tags, no spawn, and nothing Orbital
knows that the CLI does not. Orbital should have its own answer.

## Decisions taken while brainstorming

| question | decision |
|---|---|
| what the phone can do in v1 | full chat and spawn: session list, transcript, decisions, composer with images, new session |
| what the backend may see | nothing; a blind relay, end-to-end encrypted between Mac and phone |
| accounts | none; pairing only, by QR and a fingerprint confirmed on the Mac |
| mobile stack | Capacitor around a simplified mobile build of `web/`; no three.js, a list instead of the map |
| relay hosting | own Node/Fastify service on the existing Hetzner box under Dokploy |
| platforms | Android first, iOS right after; push through Firebase Cloud Messaging for both |
| what is tunnelled | the existing API and hub topics, behind an allowlist, not a new mobile protocol |

Ruled out, and why:

- **SDK bridge into claude.ai** ([[mirror-sessions-to-claude-ai]]): alpha
  API, trusted-device enrolment unsolved, and the phone would only ever see
  what the Claude app shows. Kept as a fallback if a relay turns out to be
  more than we want to run.
- **React Native**: native feel, but the composer and transcript would be
  written twice. The whole point of sharing is those two.
- **A backend that sees content**: it would let the phone read history while
  the Mac sleeps and put question text into push notifications, at the price
  of holding other people's transcripts and source paths on our server. Not
  a default we want to change later.
- **A purpose-built mobile protocol**: leaner on the wire, but a second
  protocol beside the hub, and every new web feature would need projecting
  by hand.
- **Accounts**: with a blind relay an account protects nothing the pairing
  key does not already protect.

## 1. Pairing and keys

**Amended 2026-10-01 by [[remote-identity-is-ed25519-with-ephemeral-session-keys]]:**
each device's permanent identity is a single Ed25519 pair, used only to
sign. There is no permanent X25519 pair; every connection instead runs a
fresh, signed ephemeral X25519 handshake (§ "Session keys" below is
superseded by that ADR — read it for the actual key schedule).

- The Mac generates a permanent Ed25519 identity when the feature is
  first enabled in Settings, stored in Orbital's data dir. The server is
  a Node process with no UI, so the Keychain is not an option there.
- The phone generates the same Ed25519 identity and keeps it in the
  platform secure store (Android Keystore, iOS Keychain) through a
  Capacitor plugin.
- **Pairing flow.** The Mac asks the relay for a one-time pairing token
  (minutes of validity) and shows a QR with the relay URL, its public keys
  and the token. The phone scans it, encrypts its own public keys to the
  Mac and presents the token to the relay. The relay forwards the bundle to
  the Mac, which shows a short fingerprint (a code or an emoji row) that
  must match the phone's screen. Only after the user confirms on the Mac is
  the device stored and the pair active. Confirmation on the Mac is
  mandatory: a photographed QR is otherwise enough to pair within the
  token's window.
- **The QR also carries a one-time secret** the relay never sees; the
  phone's redeem includes an HMAC of its public key under that secret,
  and the Mac ignores a pairing request whose proof does not verify — the
  30-bit fingerprint alone is a human check a relay could grind a key to
  match (amended 2026-10-01, see the ADR).
- **Session keys.** X25519 shared secret → HKDF → AES-256-GCM key. Every
  frame carries its own nonce with a counter and a direction bit, so a
  frame cannot be replayed in the other direction. Library: `@noble/curves`
  and `@noble/ciphers`, pure JS, identical in Node and in a WebView;
  WebCrypto's curve support differs between engines and is not relied on.
- **Revocation.** Settings on the Mac lists paired phones; removing one
  deletes its key on the Mac and tells the relay to stop routing it.
- A phone is paired with one Mac; pairing another replaces it, after a
  confirmation. A Mac may have several phones. Several Macs on one phone
  is out of v1 (decided 2026-10-01: nobody needs it yet, and it can be
  added later as a list of pairs). The "switch Mac" row in 9f goes.
- The pairing bundle carries the Mac's display name: the machine's network
  name by default, editable only in the desktop's Settings → Mobile, never
  on the phone. The relay keeps it in the clear: it is the one thing a
  generic push can say.
- The fingerprint is six characters, grouped 3 + 3 (9e); the pairing token
  expires after two minutes and the phone then says "code expired, scan
  again".

## 2. Relay

New workspace `relay/`: Fastify + `ws`, one Docker image for Dokploy, TLS
from the Dokploy proxy, state in SQLite (public keys, pairs, push tokens,
pending pairing tokens — nothing else).

- **Identity without accounts.** Every device authenticates by signing a
  challenge with its Ed25519 key. The relay knows public keys, which phone
  may talk to which Mac, and the phone's push token.
- **Pairing endpoints.** One for the Mac to mint a pairing token, one for
  the phone to redeem it with its public keys, one for the Mac to confirm
  or reject, one for the Mac to revoke.
- **Routing.** One WebSocket per device. A frame carries a small clear
  header (`to`, `wake`, chunk bookkeeping) and an encrypted body. The relay
  checks the pair exists and forwards; it never parses the body.
- **Presence.** When a Mac disconnects the relay tells its phones
  `offline`, and the reverse, so the phone can label stale state as stale.
- **Caps.** A maximum frame size; a per-connection buffered-bytes limit
  past which the relay stops reading from the other side (backpressure via
  `ws`'s `bufferedAmount`); a short queue for a phone that is not
  connected, holding empty-body wake frames only (a frame with content is
  sealed under keys the phone's next handshake replaces, so it could never
  be read) and bounded in devices as well as frames; rate limits on
  pairing, per client IP, counted only for signed requests.
- **Push.** If a frame is flagged `wake` and the phone is not connected, the
  relay sends a Firebase Cloud Messaging notification with generic text
  ("a session needs your input" and the Mac's name). Content never leaves
  the Mac in the clear. The `wake` header carries an opaque per-session
  token (a hash, not the id) so the relay can collapse two pending sessions
  into "2 sessions need your input" (9g) without knowing which they are;
  that the relay can count them is the one deliberate leak. Decrypting
  content inside the notification (iOS
  Notification Service Extension) is a v2 option.
- **Logs.** Metadata only, `relay:`-prefixed lines: a device connecting
  and disconnecting (an id prefix of `LOG_ID_PREFIX_CHARS`), pairing
  tokens minted, redeemed, confirmed, rejected and pairs revoked (id
  prefixes), pushes sent or failed (a push-token prefix and the count). Never a
  frame body, never a display name. The runbook [[run-the-relay]] lists
  them exactly.

The relay deliberately cannot: serve history, store transcripts, or do
anything that needs to read a body. The relay URL is a setting on the Mac
and on the phone so anyone can host their own; end-to-end encryption plus
a replaceable relay is the trust argument for other users.

## 3. Mac side (`server/`)

New module `server/src/remote/`, active only when the user enables it in
Settings. Disabled, Orbital is unchanged.

- **Identity and devices.** Key pairs in the data dir; paired phones in a
  new SQLite table (public keys, name, paired at, last seen). Settings gets
  a Mobile section (the name 9e tells the user to look for): enable,
  pairing QR, the fingerprint confirmation, device list with revoke, relay
  URL.
- **Outbound connection** to the relay with reconnect and a watchdog, the
  same shape the web client already has towards the server
  ([[2026-09-22-ws-reconnect-resync-design]]). The Mac never listens for
  inbound connections; the local port stays on `127.0.0.1`
  ([[api-token-guards-the-local-port]] is unaffected either way).
- **Dispatcher.** Decrypts a frame and routes it by type:
  - *hub frame* (`subscribe`, `unsubscribe`) goes to the existing `Hub`
    through a virtual socket. `Hub` needs only `send` and `on`, so a phone
    is just one more subscriber and every topic flows unchanged. One
    virtual socket per phone.
  - *http frame* (method, path, body) goes through Fastify `inject()`:
    in-process, same routes, same validation, same errors. An allowlist of
    paths is checked first — a literal list in one file, not a pattern:
    sessions, messages, decisions, spawn, attachments, images, models,
    tags, pin, end, interrupt, and the phone's own notification settings
    (see § 5). Refused: `/api/files`, the IDE bridge, every other settings
    route, dev tools.
  - *binary frame* (image down, attachment up) is chunked, 64 KB per
    frame, each chunk encrypted on its own so a large screenshot never
    blocks the socket the transcript shares. The last chunk hands the
    bytes to the existing image store (`putBytes`) or reads from it.
- **Wake flag.** When the `sessions` topic carries `needs_input` or an
  error, the frame is flagged `wake`. The rules for what deserves a
  notification live in `desktop/src/lib/notifications.ts` today and move
  to a shared place so desktop and phone decide alike. Debounce per
  session: one wake until the phone opens it or the state changes.
- **Protocol version** in the first frame after connect. Mac, phone and
  relay update separately; a mismatch shows "update Orbital on the Mac"
  instead of breaking silently.
- **Operationally** the Mac has to be running. Background mode
  ([[2026-09-22-desktop-background-mode-design]]) covers a closed window;
  a sleeping Mac is offline and the phone learns that from presence.

Terminal sessions stay read-only, as on the web: the API already answers
409, the phone only has to not offer a composer where the web does not.

## 4. Mobile client and code sharing

- **`mobile/` workspace** is the Capacitor shell only: native projects,
  configuration, plugins (push, secure storage, QR scanner, filesystem for
  the image cache). No application logic — the same split `desktop/` has
  with Electron.
- **The mobile UI lives in `web/`** as a second Vite entry
  (`web/src/mobile/`). It shares the store, `lib/` and the panels that do
  not depend on the map: Composer, TranscriptView, MessageView,
  PermissionCard, QuestionCard, the new-session dialog. Nothing from
  `map/` is imported, so three.js stays out of the mobile bundle — to be
  verified by a bundle analysis, not assumed. No separate shared package
  yet; extract one only if the second entry starts to hurt.
- **Transport swap** is the one change to shared code that is not pure
  addition. `api.ts` fetches `/api/...` and `ws.ts` opens a socket to the
  server today. A transport interface (request + socket) gets a direct
  implementation for the web and a relay-plus-crypto one for mobile; the
  store and panels do not know which. Images: `<img src>` points at the
  API path today; a hook turns a ref into a URL — the path on the web, a
  blob from the local cache on mobile, fetched over a binary frame when
  missing. Refs are content-addressed, so the cache never expires. A tap
  opens the full image with pinch-zoom (9p); if the bytes fail the box
  stays and offers retry.
  Attachments go the other way through the same frame, and the phone
  downscales photos before upload (9b shows 4032 px sent at 1568 px): a
  camera photo is 3–5 MB and the model does not need it.
- **Pages** by page size on mobile: 30 messages, "older" on pull. The
  history route already paginates (`limit`, `before`).
- **Screens** (layout and look are Claude Design's, not this document's):
  1. Session list instead of the map: needs input first, then working,
     idle, ended; tags as a filter; the map's state colours and vocabulary
     so it still reads as Orbital.
  2. Session: transcript, decision cards, composer.
  3. New session: directory, mode, model. The directory is searched
     across every directory a session ever ran in (`GET /api/projects`),
     not only the recent few, and can also be typed in full; the server
     validates it when the session is created. No file browser (decided
     2026-10-01; 9d shows recents only and needs the search field and
     the typed path).
  4. Settings: pairing, devices, relay status.
- **Offline.** The phone keeps the last known session list and the last
  page of each opened transcript locally, shows them labelled with when
  they were fresh, and locks the composer while the Mac is offline. Retry
  is one bounded presence check against the relay (9a), not a reconnect
  loop with a spinner.
- **Two states the canvas does not draw yet:** the Mac revoked this phone
  (unpaired, offer to pair again) and a protocol version mismatch ("update
  Orbital on the Mac"). Both are terminal states of the connection, not
  variants of offline, and need their own treatment.
- **Connection lifetime.** Both platforms kill background sockets. The app
  resyncs from the server every time it returns to the foreground and
  never assumes the socket survived; push covers the gap.
- **Distribution.** Android APK and Play internal testing first, TestFlight
  for iOS right after. The Apple account exists from the desktop signing.

## 5. Push and notifications

- The phone sends its Firebase Cloud Messaging token on every connect; the
  relay keeps it per device.
- The Mac never sends pushes; it flags frames `wake`. The relay pushes only
  when the phone is not connected. A connected phone receives the frame,
  decrypts it and shows a local notification with full content.
- Relay push text is generic: "Orbital: a session needs your input" plus
  the Mac's name. Tapping opens the app, which connects and fetches the
  current state.
- **Each phone has its own notification settings**, the desktop's five
  rows, stored on the Mac against the paired device and edited only from
  the phone, over an allowlisted route; the desktop shows nothing of them.
  They are copied from the desktop's at pairing time and live separately
  after that; a change on the phone never touches the desktop, and the
  reverse (decided 2026-10-01 — "background
  only" and "sound" are per device by nature, and the phone usually wants
  fewer events than the desk). The Mac applies the phone's rules when it
  decides `wake`, which is why they have to live on the Mac: a disconnected
  phone cannot filter what the relay pushes. The sentence on 9f about a
  change syncing to the other side goes. The evaluation itself uses the
  shared rules named in § 3.

## 6. Risks and open points

Ordered by how much they can sink or inflate the plan.

- **The Mac must be awake.** Otherwise the phone sees nothing. That is a
  property of the blind relay, not a bug; if it turns out unbearable, it is
  the one argument for a content-seeing backend, which was rejected.
- **Composer quality in a WebView.** Tiptap on Android has known IME and
  autocorrect problems. Before building the full UI, spike that the shared
  composer is usable on Android; if not, mobile gets a plain textarea and
  composer sharing shrinks.
- **A bundle without three.js.** The store or panels may pull the map in
  indirectly. If so, splitting imports is the first job, not the last.
- **The relay is a single point of failure.** One box, one process. Enough
  for two people; for others the relay URL must be replaceable.
- **Protocol versions.** Handshake with a version from the first build.
- **Pairing security.** The Mac-side confirmation is mandatory, see § 1.
- **v1 is large.** Recommended order, each step usable on its own:
  1. relay and pairing;
  2. Android read-only: session list and transcript;
  3. decisions;
  4. composer and images;
  5. spawn;
  6. iOS.

## 7. Phone client contract

Added 2026-10-01, from building [[2026-10-01-mobile-remote-backend]]:
what the backend already assumes about a phone client, so the phone's
own implementation does not have to rediscover it by reading the server.

- **Build query strings with `URLSearchParams`.** The allowlist
  (`server/src/remote/allowlist.ts`) rejects a raw space or a `'` in a
  query string outright, along with anything else that is not the exact
  canonical path Fastify's router would produce. `URLSearchParams`
  percent-encodes correctly by construction; hand-built query strings are
  not guaranteed to.
- **Page transcripts small.** An `http_res` frame is one WebSocket frame
  and is capped at `MAX_FRAME_BYTES` (`shared/src/remote/frame.ts`); a
  response over the inner limit comes back as a 413 (§ 3 and the ADR
  [[the-phone-tunnels-the-api-behind-an-allowlist]]). Request history
  pages, do not try to fetch a whole transcript in one call.
- **Subscribe to `sessions` and `errors` after `hello`.** Those are the
  two hub topics the phone needs for the session list and wake
  notifications. Only the topics the web client uses are open to a phone
  (`PHONE_ALLOWED_TOPICS` and its prefixes `session:`, `subagent:`,
  `task-output:` in `server/src/remote/phoneSession.ts`); any other
  subscribe, `remote` included, is ignored. After a re-handshake the
  phone says `hello` and subscribes again: the Mac drops the old
  connection's subscriptions.
- **On a `dropped` hub frame, refetch over REST.** A hub frame too large
  for one relay frame arrives as `{ topic, event: 'dropped', reason:
  'too_large', id? }` instead (`id` is the message's id when the frame
  carried one). Refetch that session's page over REST with a smaller
  `limit`; chunked JSON is a known gap (§ 8).
- **Ignore an empty-body frame.** A wake frame has no body; what it says
  lives in the clear header (§ 2), and the relay queues only those for an
  offline phone.
- **Handshake whenever the Mac is reachable, not only on `paired`.**
  Send the initiator's handshake message on `paired`, on `ok` when it
  lists the Mac as online, and on the Mac's `presence` with `online:
  true`. The relay's `paired` is sent before the Mac's `POST
  /pair/confirm` answers, so the Mac already expects the phone's identity
  by then — do not wait for anything else.
- **A redeem can answer 200 and still go nowhere.** The relay forwards the
  request; the Mac ignores it when its code is no longer on screen, a
  request is already pending, or the pairing proof does not verify.
  Time out the "confirm on your Mac" wait after `PAIRING_TOKEN_TTL_MS`
  and offer to scan again.
- **Send `push_token` again after `paired`.** The relay keeps no row for
  a device that has not redeemed a code, so a push token sent before the
  redeem is dropped.
- **Local notifications come from the hub, not the wake frame.** A wake
  frame names no session; a connected phone decides what to show from the
  `sessions` and `errors` frames it receives, under its own notification
  settings.
- **The relay's `?mac=` query parameter is the Mac's id from the QR**,
  the same id the QR's `mac` field carries. It is not read by the relay
  today (see [[run-the-relay]]'s "More than one instance"), but a client
  should send it on every connection anyway, since a future sticky-
  routing deployment depends on every client already doing so.

## 8. Known gaps after the backend plan

Added 2026-10-01: things [[2026-10-01-mobile-remote-backend]] left as is,
deliberately, rather than incidentally.

- **A revoke while the remote is off never reaches the relay.** `revoke()`
  always removes the device locally first; telling the relay is best
  effort and is simply not attempted when there is no live client. The
  relay keeps a pair that is dead on the Mac side — harmless, since the
  Mac no longer accepts frames from that phone, but it means a phone
  revoked while the Mac was asleep can still open a WebSocket to the
  relay and receive `presence`/`paired` control traffic until someone
  revokes it again (or redeploys) while the remote is on.
- **A failed start does not retry on identical settings.** If the Mac
  fails to connect (say, a bad relay URL), saving the exact same
  settings again does not retry the connection — some value has to
  change, or the user has to toggle `remote_enabled` off and on.
- **No chunked JSON.** A hub frame or REST answer larger than one relay
  frame is not split: the REST answer becomes a 413 and the hub frame a
  `dropped` notice (§ 7). A single message too large for one frame (one
  huge tool result) cannot reach the phone at all until JSON travels in
  chunks the way images do.
- **`ORBITAL_VERSION` is not set by the desktop fork yet.** `hello.server`
  (`server/src/index.ts`) reads `process.env.ORBITAL_VERSION ?? 'dev'`,
  and `desktop/src/main.ts` does not set it when forking the server, so
  a paired phone always sees `server: 'dev'`. Tracked in
  `docs/chores/desktop-follow-ups.md`.

## Before implementation

- Draw the Mac side on the canvas: Settings → Mobile with the QR, the
  fingerprint confirmation dialog and the device list; and on the phone the
  revoked and version-mismatch states.
- Pick the default relay hostname (9e shows a placeholder).
- Spike the Android WebView composer.
- Write the plan from this spec once the idea is no longer non-binding.
