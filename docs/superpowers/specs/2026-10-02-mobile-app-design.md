---
id: 2026-10-02-mobile-app-design
title: Mobile app — the phone client, phase 2a (read) and 2b (write)
status: active
type: spec
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - 2026-10-01-settings-mobile-design
  - 2026-10-01-mobile-remote-backend
  - the-phone-client-lives-in-shared-and-tests-against-the-real-mac
  - remote-identity-is-ed25519-with-ephemeral-session-keys
  - the-phone-tunnels-the-api-behind-an-allowlist
  - why-orbital
tags:
  - mobile
  - relay
  - capacitor
  - web
---
# Mobile app

**Status: active.** Brainstormed 2026-10-02 as phase 2 of the mobile
remote. The backend ([[2026-10-01-mobile-remote-backend]]) and the
desktop's Settings → Mobile ([[2026-10-01-settings-mobile-design]]) are
merged; this is the phone. [[2026-09-30-mobile-remote-design]] §§ 4, 5
and 7 are the parent text and still bind; this spec is what they left
open, plus the split into two deliveries.

Canvas: `Feature - Mobile.dc.html`, phone artboards 9a–9i, parts and
states in 9p. The fidelity pass against the canvas is the main session's,
in a mobile viewport and on the Android emulator.

## Decisions taken while brainstorming

- **Two deliveries.** 2a is everything a phone needs to *read*: the
  shell, pairing, the transport, the session list, the transcript, the
  settings screen, offline, unpaired and version-mismatch. 2b is
  everything that *writes*: decisions, the composer with photos, new
  session, push and notifications. One spec, two plans, two branches.
  Each is usable on its own (parent § 6 order).
- **The protocol client lives in `shared/`**, not in `web/`: it has no
  DOM, it needs a WebSocket implementation injected (the browser's on the
  phone, `ws` in Node), and that is what lets it be tested in Node
  against the real relay and the real server, where the fake phone
  stands today. See the ADR
  [[the-phone-client-lives-in-shared-and-tests-against-the-real-mac]].
- **The mobile UI is a second Vite entry in `web/`** (parent § 4): it
  reuses the store, `lib/` and the transcript panels. Three map imports
  exist outside `map/` today (`App.tsx`, `Settings.tsx`, and the store's
  `ENDED_HIDE_MS` from `map/transition`); none of them pulls three.js in,
  and a test over the build manifest keeps it that way.
- **Android Studio and an emulator exist on the owner's Mac**, so
  implementers build and run the APK themselves; the composer spike on
  the Android WebView (parent § 6) opens 2b, not 2a, because 2a has no
  composer.
- **Push waits for 2b.** The Firebase project does not exist yet; 2a has
  no push token, so wake frames only reach a connected phone. 2a still
  sends `seen` and reads/edits the phone's notification rules, so that
  2b only adds the token and the local notifications.
- **No default relay.** The QR carries the relay URL (decided
  2026-10-02 in [[2026-10-01-settings-mobile-design]]); the phone never
  asks for one and 9f's "Reset to default" goes — the relay row shows the
  paired relay's hostname and nothing is editable.

## 1. Workspaces and builds

**`mobile/`** (`@orbital/mobile`, a sixth npm workspace) is the Capacitor
shell and nothing else, the way `desktop/` is the Electron shell:
`capacitor.config.ts` (appId `io.slothworks.orbital.mobile`, appName
`Orbital`, `webDir: '../web/dist-mobile'`), the generated `android/`
project committed as Capacitor expects, and scripts: `build` (the web's
mobile build, then `cap sync android`), `apk` (`gradlew assembleDebug`),
`run` (`cap run android`). Capacitor 8 with `@capacitor/app` (foreground
events, the hardware back button), `@capacitor/preferences` (small JSON
state), `@capacitor/filesystem` (the image cache),
`@capacitor-mlkit/barcode-scanning` (the QR scanner), `@capacitor/device`
(the phone's model name for pairing) and
`@aparajita/capacitor-secure-storage` (the identity, in the Android
Keystore / iOS Keychain). `@capacitor/push-notifications` comes with 2b.
iOS is generated the same way after Android works; nothing here is
Android-only except the generated project.

**`web/`** gains `index.mobile.html`, `vite.mobile.config.ts` (output
`dist-mobile`, no dev proxy — the phone never talks to a local server)
and scripts `build:mobile` and `dev:mobile`. The entry is
`web/src/mobile/main.tsx`. In a plain desktop browser the same entry runs
with web fallbacks so layout work and the fidelity pass need no device:
secure storage falls back to `localStorage` (dev only, labelled), and the
scanner screen offers a paste field for the QR text when no camera API
exists. A test in `web/` reads `dist-mobile/.vite/manifest.json` and
fails if any chunk's imports include `three` or `@react-three`.

**Reuse from the desktop entry.** The store (`store/store.ts`), `lib/`,
and the transcript panels (`TranscriptView`, `MessageView`, `ToolRow`,
`ThinkingBlock`, `ImageThumb`, `Lightbox`, the decision cards in 2b).
Mobile row metrics (9b: tool rows 44 px, folded runs on two lines) are
applied through a `data-platform="mobile"` attribute on the root and CSS
in `web/src/mobile/mobile.css`, not through props threaded into every
panel. Nothing in `panels/` imports from `mobile/`.

## 2. The protocol client (`shared/src/remote/client.ts`)

`RemoteClient` is the phone side of everything `server/src/remote/`
expects (parent § 7 is its contract). Options: `relayUrl`, `mac` (the
Mac's id from the QR), `identity`, `WebSocketImpl` (a constructor taking
a URL, with `binaryType = 'arraybuffer'` semantics; the browser's
`WebSocket` or `ws`), `app` (the `hello` app string), `now?`.

- **Relay link.** Connects to `relayWsUrl(relayUrl, mac)`, answers the
  `challenge` with `authSignature`, keeps `peersOnline`, reconnects with
  the same backoff shape as the Mac's `RelayClient`
  (`RECONNECT_DELAY_MS`, `RECONNECT_MAX_MS`, a connect timeout, a
  silence watchdog). Status: `off | connecting | online`; the Mac's
  presence is a separate boolean `macOnline`.
- **Handshake** (parent § 7): the initiator message goes out on
  `paired`, on `ok` listing the Mac, and on `presence online`; the
  responder half completes the cipher. After every new cipher the client
  sends `hello` with `PROTOCOL_VERSION`, waits for the Mac's `hello`,
  then re-sends every subscription it holds. `bye` is surfaced as an
  event with its reason; the client does not reconnect after
  `revoked`.
- **Requests.** `request(method, path, body?)` sends `http` with a
  fresh id and resolves `{ status, body }` from the matching `http_res`;
  it rejects after a timeout (`REQUEST_TIMEOUT_MS`), when the cipher is
  lost mid-flight, and on `bye`. Unknown response ids are ignored.
  Paths are built by the caller with `URLSearchParams`.
- **Hub.** `subscribe(topic)` / `unsubscribe(topic)` send `ws` messages;
  incoming `ws` frames are emitted as `hub` events with the frame
  verbatim, `dropped` included.
- **Blobs.** `getBlob(ref)` sends `blob_get`, reads `blob_meta`, collects
  the chunks and resolves `{ status, bytes, mediaType }`; `putBlob` (2b)
  mirrors `blob_put`. Chunks interleaving with JSON is normal and handled.
- **Wake.** A frame with an empty body is reported as a `wake` event
  with its header flags and nothing else; the app decides what to show
  from the hub, never from the wake frame (parent § 7).
- **Pairing.** `redeem(token, secret, name, platform)` posts
  `/pair/redeem` with the proof; the caller then waits for `paired` or
  `rejected`, bounded by `PAIRING_TOKEN_TTL_MS`.
- **Notifications and seen.** `getNotifications()`, `setNotifications()`,
  `seen(sessionId)`, and `pushToken(token)` (2b, re-sent after `paired`).
- Listeners never throw out of the client; a bad frame is dropped and
  counted, never fatal.

The client is tested in `server/test/remoteClient.test.ts` against the
real relay and the real `buildServer`, the harness
`remoteEndToEnd.test.ts` already has: pair, hello, subscribe and receive
a `sessions` frame, request an allowed and a denied path, fetch an
image, edit notifications, lose the Mac and get it back (re-handshake,
re-subscribe), revoke → `bye revoked`. `remoteFakePhone.ts` stays for
the protocol-level tests that need to misbehave on purpose.

## 3. Platform wiring in `web/`

Three seams, all defaulting to today's behaviour so the desktop entry is
untouched:

- `lib/api.ts`: every `fetch(` in the file goes through one `apiFetch`,
  and `configureApi({ fetch })` replaces it. Mobile passes
  `tunnelFetch`, which turns a relative `/api/...` URL and `RequestInit`
  into `client.request()` and answers a `Response` (status, JSON body;
  413 and 403 from the Mac arrive as ordinary statuses). Multipart
  uploads (`uploadImage`) are not routed through it: 2b sends photos as
  blobs and then references them, which is what the Mac side already
  expects.
- `lib/socket.ts`: `configureSocket({ WebSocketImpl })` before the first
  `getSocket()`. Mobile passes `TunnelSocket`, an object with the
  WebSocket surface `OrbitalSocket` uses (`send`, `close`, `onopen`,
  `onmessage`, `onclose`, `readyState`): `send` of a subscribe or
  unsubscribe becomes `client.subscribe/unsubscribe`, every `hub` event
  becomes an `onmessage`, and the socket reports open exactly while the
  tunnel has a live cipher after `hello`. `OrbitalSocket`'s own
  reconnect and heartbeat watchdog stay as they are; the tunnel's
  liveness shows up as open/close.
- `lib/images.ts`: `useImageUrl(ref)` with a configurable resolver.
  Web: the API path, as `ImageThumb` and `Lightbox` build it today.
  Mobile: a blob URL from the file cache (`Filesystem`, directory
  `Cache`, name = ref), fetched with `client.getBlob` when missing;
  content-addressed, never expires; a failed fetch keeps the box and
  offers retry (9p).

`web/src/mobile/boot.ts` does the wiring once: load the identity (or
generate it), load the pairing, construct the client, configure the three
seams, subscribe `sessions` and `errors` after `hello`, resync on every
foreground (`App.addListener('appStateChange')`), and route the hardware
back button.

## 4. State the phone keeps

- **Identity** (Ed25519, `generateIdentity()`) in secure storage. Lost
  only by uninstall or by "Pair a different Mac".
- **Pairing** in Preferences: `{ relay, mac, macName, fingerprint,
  pairedAt }`. One Mac per phone (parent § 1); pairing another replaces
  it after the 9f confirm.
- **Cache** in Preferences, JSON per key: `sessions` (the last session
  list with `asOf`), `transcript:<id>` (the last page shown, with
  `asOf`), `notifications` (the rules as last read). Cleared together
  with the pairing.
- **Unpaired** is reached on `bye revoked`, on the relay's `unpaired`,
  or on a relay `error` that says the pair is gone: the pairing, the
  identity and the cache are deleted on first contact, then 9h shows.
  "Not now" leaves the app on 9h; it comes back on every launch until a
  new pairing.

## 5. Screens (2a)

Navigation is in-memory state, not URLs: `pairing | list | session |
settings | unpaired | mismatch`. The hardware back button pops one
level; on the list it backgrounds the app.

**9e Pairing.** Step 1 opens the scanner at once; a scanned code is
parsed with `QrPayload`, the client connects to that relay, `redeem`
goes out with this phone's name (the device model, from Capacitor's
`Device` info or a fixed "Android phone") and platform. Step 2 shows the
Mac's name, the six-character fingerprint from `fingerprint(macKey,
phoneKey)` in the 3 + 3 boxes, the draining bar from
`PAIRING_TOKEN_TTL_MS`; `paired` → handshake → `hello` → the "Paired
with" screen with relay hostname, "end-to-end", the fingerprint and
"Open sessions"; `rejected` or the timeout → "Code expired · scan again"
with Cancel / Scan again. Cancel at any step closes the socket and
returns to the previous screen (or stays on pairing when there is no
pairing yet).

**9a Session list.** Groups in order: needs input (amber-edged card),
working, idle, ended (collapsed, "latest N ago"). Row: state glyph (9p
sizes and motion), title, tag dot + cwd basename, `⎇ branch`, elapsed
or last activity; needs-input rows add the reason on a third line;
terminal sessions carry READ-ONLY; a subagents row appears only when
subagents exist and expands in place. Tag chips filter locally, counts
are live sessions. Data: the store's session list through the tunnel
(`GET /api/sessions`, the `sessions` topic). The "+ New session" button
is drawn, disabled, with "coming with 2b" as its reason — 9d is 2b.

**9a offline.** When the relay is online and `macOnline` is false (a
relay still connecting is only the header's dim dot): the neutral card
"<Mac> is asleep", "Showing what it last sent. Reconnects on its own when
the Mac wakes.", `as of <asOf>`, Retry = one presence check (reconnect
the relay link once, wait for `ok`, at most `RETRY_WINDOW_MS` = 5 s),
then "checked just now". While a Retry or a foreground check runs, the
offline presentation holds what it showed before the check
(`rechecking`), so a healthy Mac never flashes the card. Glyphs keep their
colour, dimmed, no motion. New session reads "needs <Mac> awake".

**9b Transcript, read-only.** The desktop transcript panels through the
tunnel with pages of `TRANSCRIPT_PAGE_SIZE` = 30 and "older" on pull at
the top (the history route's `limit` and `before`). Sticky two-row
header as 9b. Images reserve their box from `w × h` and fade in from
the cache. No composer in 2a: the composer area is the 9p
"terminal session · no composer" line for terminal sessions and is
simply absent for Orbital sessions until 2b. Offline: the state reads
"WAS <STATE> · as of", a divider marks where the data ends, "NOTHING
NEWER · MAC ASLEEP".

**9f Settings.** MAC: name, online/offline, live session count, "Pair a
different Mac" → confirm sheet "Replace <Mac>?" → forget the pairing,
the identity and the cache, open the scanner. NOTIFICATIONS: the
desktop's five rows in the same order, read with
`getNotifications()` on open, each toggle `setNotifications()`;
caption "Just for this phone. Copied from your Mac when you paired."
ADVANCED: the relay's hostname, read-only, "Must match the relay set on
the Mac." Footer: `orbital mobile <version>` from `mobile/package.json`
and the fingerprint.

**9h Unpaired** and **9i Version mismatch** as drawn. Mismatch triggers
on `bye protocol` (the Mac refused our `PROTOCOL_VERSION`) or when the
Mac's `hello.server` is older than `MIN_SERVER_VERSION` (a constant in
the mobile entry, compared as dotted numbers; `dev` counts as newest).
It shows both versions when it has them, "Try again" is one bounded
reconnect + hello (`RETRY_WINDOW_MS`), and it re-checks on every
foreground. The whole app is blocked behind it.

**Transport states the user sees** (9a header): `connecting` to the
relay shows a dim dot; relay online but Mac offline is the 9a offline
card; both online is live. The in-app banner and system notifications
are 2b.

## 6. What 2b adds

In its own plan, from this spec and the parent:

1. The Android WebView composer spike (parent § 6): the shared Tiptap
   composer on a real device; if the IME misbehaves, a plain textarea
   composer for mobile.
2. 9c decisions: permission, plan approval, question card — the desktop
   cards with 9c's touch sizes; the composer as the escape hatch.
3. 9b composer: text, camera and gallery photos downscaled to
   `PHOTO_MAX_EDGE` = 1568 px, sent with `putBlob` and referenced;
   Stop while working; locked line while offline.
4. 9d new session: one field that searches every directory ever used
   (`GET /api/projects`) and accepts a typed path; mode and model from
   the desktop defaults; first prompt; `POST /api/sessions`.
5. Push: `@capacitor/push-notifications`, the FCM token sent with
   `pushToken()` on every connect and again after `paired`; 9g's system
   notification (generic, from the relay) and in-app banner (from the
   hub, under the phone's rules); `seen` when a session is opened.
6. iOS: the generated project, TestFlight.

## 7. Testing

Worth a test:
- `RemoteClient` end to end against the real relay and server (§ 2);
  pure parts on their own: request id matching and timeouts, blob
  reassembly out of interleaved frames, the handshake trigger rules
  (`paired`, `ok` listing the Mac, `presence online`).
- `tunnelFetch`'s translation of `RequestInit` and relative URLs into
  `http` messages and of `http_res` into `Response` (jsdom).
- `TunnelSocket`'s open/close rule (open only with a cipher after
  `hello`).
- Offline/unpaired/mismatch derivation from client events; the version
  comparison; the pairing and cache parsers (bad JSON → empty).
- The bundle guard over the mobile manifest.

Not tested: screens render their rows, 9p sizes, motion.

## As built (2a)

Built from [[2026-10-02-mobile-app-read]]. Decisions the spec left open:

- **Redeem across origins.** The WebView's page is `https://localhost`, so
  the relay now answers CORS for `/pair/redeem` and nothing else
  ([[the-relay-answers-cors-for-redeem]]). A deployed relay must be
  redeployed before a phone can pair through it.
- **The bundle guard reads a module list.** A Vite manifest names chunks,
  not the modules in them; `vite.mobile.config.ts` also writes
  `.vite/chunk-modules.json`, and `web/src/test/mobilebundle.test.ts` reads
  both. `npm test` skips it without a build; `npm run build -w @orbital/mobile`
  runs it after every build, where a missing build fails.
- **Groups.** WAITING sits with WORKING; DONE and INTERRUPTED sit with IDLE
  and keep their own word on the row (`web/src/mobile/sessionList.ts`).
- **`MIN_SERVER_VERSION` is `0.17.1`**, the release that shipped Settings → Mobile.
- **The relay link's silence watchdog runs only while a tunnel is up.** The
  relay's pings never reach page code, so a quiet link with the Mac away
  cannot be told from a dead one; every return to the foreground rebuilds
  the link instead (`recheck`).
- **The paste field** shows when there is no scanner and in every dev build
  (`ORBITAL_MOBILE_DEV=1`), where a complete code pairs as it is typed —
  that is how `mobile/scripts/pair-emulator.sh` pairs the emulator. A
  scanner whose ML Kit module is still installing is not "no scanner":
  Scan code stays, with a one-line note to try again in a moment.
- **A phone revoked while it was away** is told so by the relay on its
  next connect: the client connects with `paired=1` when built from a
  stored pairing, and the relay answers `unpaired` when the Mac has no pair
  with it (Task 14; parent spec § 7).
  A client built while pairing turns the same flag on itself when it hears
  `paired`, so its later reconnects ask too.
- **No backup.** `android:allowBackup="false"` and data-extraction rules
  that exclude everything: the caches are plaintext, and the identity is per
  device — its Keystore key does not travel, so a restored copy could not be
  decrypted.
- **The system bars are dark** whatever the system theme (SystemBars
  `style: DARK`), so the status bar icons are light on the app's background.

## 8. Known limits of 2a

- Wake frames reach only a connected phone: no push until 2b.
- The phone cannot answer anything: no composer, no decisions.
- No iOS build yet; nothing in the code is Android-only.
