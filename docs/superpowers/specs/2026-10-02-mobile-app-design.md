---
id: 2026-10-02-mobile-app-design
title: Mobile app — the phone client, phase 2a (read) and 2b (write)
status: active
type: spec
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - switch-model-and-mode-from-the-phone
  - 2026-10-01-settings-mobile-design
  - 2026-10-01-mobile-remote-backend
  - the-phone-client-lives-in-shared-and-tests-against-the-real-mac
  - the-connected-phone-notifies-itself
  - 2026-10-02-mobile-app-read
  - 2026-10-02-mobile-app-write
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
  uploads (`uploadAttachment`) are not routed through it: 2b adds a
  second seam, `configureApi({ upload })`, and the phone's uploader sends
  a photo as a blob (`putBlob`) and then references it, which is what the
  Mac side already expects (§ 6.2).
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

## 6. What 2b adds (write)

Brainstormed 2026-10-02 after 2a merged; built from
[[2026-10-02-mobile-app-write]]. Everything an Orbital session can be
told from the phone: a reply with photos, a decision, a new session, and
the notifications that bring the phone out. Terminal sessions stay
read-only.

### Decisions taken for 2b

- **No composer spike.** The shared Tiptap `Composer` goes straight in.
  `adb` types past the IME, so the only honest test of autocorrect and
  composition is a person typing on the emulator with Gboard — and that
  is the fidelity pass. If the pass finds the field unusable, the fallback
  the parent § 6 planned (a plain textarea composer for the phone) is
  built then, not ahead of need.
- **The connected phone notifies itself**
  ([[the-connected-phone-notifies-itself]]). Android keeps a backgrounded
  WebView's socket alive for a while, the relay then sees the phone
  connected and pushes nothing — so the phone posts a local notification
  from the hub frames it still receives, naming the session, and the
  relay's generic push covers the time after the OS kills the socket.
  Closing the link on every pause, so that every notification is a relay
  push, was rejected: one path, but a generic one, and the Mac would see
  the phone offline while its owner is one swipe away.
- **The in-app banner is UI, not a notification.** It shows for every
  notification-worthy transition that arrives while the app is in the
  foreground, except for the session on screen. The "background" rule
  governs system notifications alone: on, the phone posts none while the
  app is in the foreground; off, it posts one even then, next to the
  banner. The row reads "Only when the app is in the background".
- **iOS is 2c.** Xcode 26 and CocoaPods are on the owner's Mac; the
  generated project, signing and TestFlight get their own brainstorm and
  plan once Android writes.
- **Firebase is the owner's.** A Firebase project with the Android app
  `io.slothworks.orbital.mobile`; `google-services.json` goes to
  `mobile/android/app/` (git-ignored — the Gradle template already applies
  the plugin only when the file exists) and a service-account JSON to the
  relay (`RELAY_FCM_SERVICE_ACCOUNT`, [[run-the-relay]]). Without either
  file everything builds and runs; the relay logs the pushes it would send.
- **Desktop defaults reach the phone through one narrow route.**
  `/api/settings` stays denied (the backend plan's denied set). `GET
  /api/sessions/defaults` answers the three settings 9d needs and the
  allowlist names it, with `defaults` in `RESERVED_SEGMENTS` so `:id`
  never swallows it.
- **The phone minimum rises.** 9d needs the defaults route and the
  directory check, so `MIN_SERVER_VERSION` becomes the desktop version
  that ships 2b (set at merge, when the owner picks the bump).

### 6.1 Composer (9b)

- The shared `Composer` (`panels/Composer.tsx`): `variant: 'panel'`,
  `placement: 'above'`, `enter: 'newline'` — the on-screen keyboard's
  return key makes a line and only Send sends. `sessionKey` is the
  session, so slash-command completions work (`GET /api/commands`). The
  hint line is empty on the phone: there are no chords to name. No IDE
  slot, no rewind, no drop target; paste intake stays.
- The action row under the field (9b): camera · gallery · Stop (only
  while `status === 'working'`) · Send (`↑`, dim until there is text or an
  armed chip). Stop opens the desktop's `StopDialog`, which calls
  `api.interrupt`. Every control is a 44 px target.
- Sending is the store's `sendPrompt(id, text, images)`: the same
  optimistic turn, the same `uuid` patch, the same escape hatch for a
  parked decision (§ 6.3). The draft is `composerDrafts[id]`, so leaving
  and coming back keeps it.
- Locked (9p): while the Mac is asleep the composer is the dashed locked
  line "<Mac> is asleep — read only", attach and send inert; a terminal
  session gets "Started in Terminal — reply there." and no composer.
- With the keyboard up the composer sits on it and the transcript shrinks
  (the root is `100dvh`); the fidelity pass owns the metrics.

### 6.2 Photos

- `@capacitor/camera` in the shell, one `Camera.getPhoto` per button
  (`CameraSource.Camera` / `CameraSource.Photos`, `CameraResultType.Uri`).
  No permission is declared or asked: the plugin hands the shot to the
  system camera app, which owns its own permission, and the photo picker
  needs none on Android 13+ (corrected as built — declaring CAMERA would
  make the plugin ask for a permission the intent does not need).
- The phone downscales before upload (parent § 4): the longer edge to
  `PHOTO_MAX_EDGE` = 1568, JPEG at `PHOTO_JPEG_QUALITY`; `fitWithin(w, h,
  max)` is the pure part and a photo already within the edge is sent as
  it is. The result is a `File` through `useAttachments.accept([file],
  source)`, so the chip row, retry and the send path are the desktop's.
  `AttachmentSource` gains `'camera'` and `'gallery'`; `Attachment` gains
  an optional `original: { w, h }` and `attachmentMeta` then reads
  "4032×3024 → sent at 1568 px" (9b).
- Upload: `configureApi` gains an optional `upload`, and
  `api.uploadAttachment` delegates to it when set. The phone's uploader
  reads the file's bytes and calls `RemoteClient.putBlob(bytes,
  mediaType)`: `blob_put` with the byte count, the chunks from
  `chunkBlob`, then one `blob_put_done` — `entry` resolves; `too_large`
  and `not_image` resolve as the desktop's refusals (`{ kind: 'too_large'
  }`, `{ kind: 'not_image' }`); `busy`, `out_of_order`, `size_mismatch`
  and `internal` reject as `TunnelError('lost')`, so the chip reads
  "didn't upload" with retry. A tunnel lost mid-upload fails the waiter
  the same way; the Mac drops its half (`PhoneSession` clears uploads on
  close). The sessionless upload (9d's first prompt) is the same call —
  the Mac's image store is global. `BLOB_PUT_MAX_BYTES` is
  `ATTACHMENT_MAX_BYTES`; a downscaled photo is far under it.
- Before photos, the deferred minor from 2a: `makeImageResolver` keeps at
  most `IMAGE_URL_CACHE_MAX` blob URLs; past that the least recently
  asked-for one is revoked and dropped (its bytes stay in the file cache,
  so a later ask re-reads the file).

### 6.3 Decisions (9c)

- `TranscriptView` on the phone is no longer `readOnly`. `PermissionCard`
  and `QuestionCard` answer through the store (`resolveDecision`,
  `answerQuestion`) as on the desktop, over the tunnel (`POST
  /api/sessions/:id/decision/:decisionId`). A pending decision reaches the
  phone on the `session:<id>` topic (`decision_pending`) the session
  screen already subscribes to; `pendingDecisions` is the source, as in
  `DetailPanel`.
- Touch metrics (9c) through `data-platform="mobile"` CSS on the cards'
  own hooks (`[data-permission-card]`, `[data-question-card]`,
  `[data-question-block]`): the primary action full width at 50 px, the
  two secondary actions sharing a row at 48 px, question rows at 60 px, no
  hover preview. The cards' props do not change (§ 1).
- The composer as the escape hatch: while a decision is pending the
  placeholder names the alternative — `composerPlaceholderFor(kind)` for
  a permission or a plan, "Answer <header>, or pick an option above…" for
  a question — and `answering` lights the well; `sendPrompt` already turns
  the text into a refusal with a reason or into the free-form answer.
  Approving a plan shows the mode it switches to (the desktop card does).
- A session opened with a pending decision lands at the end of the
  transcript, where the card is.

### 6.4 New session (9d)

- A screen `new` in the navigation, opened by the list's "+ New session"
  (live in 2b; "needs <Mac> awake" and inert while the Mac is asleep).
  × and the hardware back button return to the list; a typed draft is
  dropped.
- One field for the directory. Empty: the ten most recent directories.
  Typing filters every directory `GET /api/projects` returns, matching any
  path segment, most recent first; a typed `~/` or `/` path that matches
  nothing gets one row "Use <path> as is" with "<Mac> checks it exists
  when the session starts". Tapping a row fills the field with the full
  path. Rows: basename bold, full path in mono, last use (`lastAt`, new on
  the route), and the tag dot of a session the phone already holds in
  that directory — there is no tag-rule route for the phone, so a
  directory with no session on the list shows none. `GET /api/projects`
  answers up to `PROJECTS_LIMIT` distinct directories instead of 50, so
  "every directory" holds.
- Mode and model: the desktop's `ModeCards` and `ModelCards`, preselected
  from `GET /api/sessions/defaults` (`{ permissionMode, model,
  rememberModelPerProject }`) and, when the flag is on, the directory's
  `lastModel` from `/api/projects`. `bypassPermissions` is never
  preselected (the desktop's rule); no "Other…" model on the phone.
- First prompt: the same `Composer`, `variant: 'dialog'`, `placement:
  'below'`, `enter: 'newline'`, attachments with `sessionId: null`. Start
  is disabled until the prompt has text; with the keyboard up the button
  rides on it.
- Start: `POST /api/sessions` with `{ cwd, prompt, permissionMode, model,
  attachments }`. 201 opens the session; the list gets it from the hub.
  With `requireDirectory: true` in the body (the phone always sends it)
  the route checks the directory before launching — an absolute,
  existing directory after `~` expansion, the check `spawn_session`
  already makes — and answers 400 `{ error: 'no_such_directory' }`; the
  phone shows "Directory not found on <Mac>" inline under the field and
  keeps the screen as typed. The flag is opt-in because the desktop's
  tests launch sessions in directories that do not exist against a
  stubbed runner, and the desktop dialog has no inline place for the
  error yet. Any other failure shows inline under Start; the phone has
  no toast surface and does not report errors to the Mac's error log
  (`/api/errors` is denied to it).
- The phone remembers nothing about the last launch; the desktop's
  `new_session_last_*` are its own.

### 6.5 Push and notifications (9g)

- **Registration.** `@capacitor/push-notifications`. After boot with a
  pairing, and right after `paired` while pairing:
  `requestPermissions()` (Android 13's POST_NOTIFICATIONS prompt),
  `register()`, and on `registration` → `client.pushToken(token)` — the
  client re-sends it on every `ok` and after `paired` (§ 2, parent § 7).
  A denied permission is not an error: the app runs without
  notifications and 9f shows nothing about it.
- **Channels**, created at boot: `needs_input` "Needs input", high
  importance, silent — the one the relay addresses (`relay/src/push.ts`)
  — and `needs_input_sound` "Needs input · sound", the same with the
  default sound. The phone's `sound` rule picks the channel for its local
  notifications; a relay push is always silent (9g: "no sound by
  default"), since the relay does not know the rule.
- **Tapping** a relay push (`pushNotificationActionPerformed`) opens the
  list; tapping a local notification
  (`localNotificationActionPerformed`) opens the session it names
  (`extra.sessionId`). Opening sends `seen`, as every open does.
- **Deciding.** The shared `SessionNotifier`
  (`shared/src/notifications.ts`) is fed every `sessions` and `errors`
  hub frame and holds the phone's rules (`notifications_get` on every
  tunnel open, cached as before; a 9f edit updates it in place). It is
  rebuilt on every `ready: true` and seeded from the session list the
  resync reads (and from the cached list until then): the hub replays
  nothing on subscribe, so a fresh notifier that was not seeded would take
  each session's next frame as a first sighting and report nothing — the
  desktop seeds its watcher from the initial list for the same reason
  (corrected 2026-10-02 by the whole-branch review; the first draft assumed
  an upsert flood that does not exist). A pure
  `decideNotification(notification, { active,
  viewing, rules })` answers which of banner and system notification to
  show: in the foreground, the banner unless the session is on screen,
  plus a system notification only when `onlyWhenBackground` is off; in
  the background, the system notification alone.
- **The local notification**: title the session's name, body the
  notifier's ("Needs your input", "Session ended", the failure line),
  channel by `sound`, `extra: { sessionId }`, one id per session so a
  later transition replaces the earlier one.
- **The banner** (9g): slides down under the status bar, "<title> needs
  input" with the ask on the second line (the pending decision's chip
  label and summary when the store has it, else the notifier's body),
  hides after `BANNER_MS`, swipe up dismisses, "View" opens the session.
  One at a time; a newer one replaces it.
- The wake frame stays ignored (parent § 7): what to show comes from the
  hub.

### 6.6 Server and shared changes

`GET /api/sessions/defaults` and its allowlist entry; `GET /api/projects`
with `lastAt` and `PROJECTS_LIMIT`; `POST /api/sessions` answers 400
`no_such_directory`; `RemoteClient.putBlob`; `AttachmentSource` and
`Attachment.original`; `configureApi({ upload })`. The relay does not
change. These ship in the desktop release that moves `MIN_SERVER_VERSION`.

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

Added for 2b (§ 6):
- `putBlob` against the fake socket (the `blob_put` header and the chunks
  in order, `entry` resolving, `too_large` and `not_image` as refusals,
  `busy` and a lost tunnel as `lost`) and end to end: a PNG uploaded
  through the real Mac is fetched back with `getBlob` and referenced in a
  message body.
- `fitWithin` (landscape, portrait, already small, exact edge).
- `GET /api/sessions/defaults` (the three settings; absent → the
  desktop's own fallbacks) and its allowlist entry, with the trailing
  slash and `/api/sessions/defaults/x` denied; `GET /api/projects` with
  `lastAt` and past 50 directories; `POST /api/sessions` → 400
  `no_such_directory`.
- `filterDirectories` (empty → ten most recent; a segment match; the
  "use as is" row for a typed `~/` or `/` path; nothing for other text).
- `decideNotification` (foreground/background × viewing × the background
  rule).
- The image URL cache's bound (the oldest URL revoked past
  `IMAGE_URL_CACHE_MAX`), with `toUrl` and `revoke` injected.
- `uploadAttachment` delegating to a configured `upload`.

Not tested: screens render their rows, 9p sizes, motion, the composer on
the phone, the cards' touch CSS, the banner, the camera.

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
  cannot be told from a dead one; a return to the foreground rebuilds
  the link instead (`recheck`) — since 2b only when no tunnel is up: with
  one up the watchdog is the judge, and the rebuild used to race the
  upload of a photo picked in the camera activity (§ 6.2).
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
- **Two notification rows are reworded for the phone.** The desktop's
  "Only when Orbital is in the background" and "Play a sound" descriptions
  name desktop concepts (the window, Notification Centre) that do not hold
  on a phone; `SettingsScreen.tsx` rephrases those two and keeps the
  desktop's words for the other three. The canvas gives no copy for these
  rows, so this is the controller's call, not a design read.

## As built (2b)

Built 2026-10-02 from § 6 by subagent-driven development without a plan
file (the owner's call: the spec was the requirements document). Decisions
the spec left open or that building corrected:

- **No composer spike, and the Tiptap composer held.** Typed on the
  emulator's Gboard during the fidelity pass; no textarea fallback exists.
- **`requireDirectory` is opt-in** on `POST /api/sessions` (§ 6.4): the
  desktop's tests launch sessions in directories that do not exist against a
  stubbed runner, so the check is a body flag the phone always sends.
- **No camera permission** is declared or asked (§ 6.2): the plugin hands
  the shot to the system camera app. `Camera.getPhoto` is deprecated in
  `@capacitor/camera` 8.x and still works; moving to `takePhoto` /
  `chooseFromGallery` is in [[mobile-follow-ups]].
- **The phone sends images only.** `tunnelUpload` refuses a file over
  `ATTACHMENT_MAX_BYTES` or whose type is not `image/*` before reading it;
  a pasted non-image file is a `not_image` refusal on the chip, where the
  desktop would upload it by path.
- **Push needs a build with `google-services.json` present.**
  `vite.mobile.config.ts` sets `__MOBILE_PUSH__` from the file's presence;
  without it the app asks for the notification permission (local
  notifications need it) but never calls `register()`, which crashes the
  app when Firebase is not initialised. The Gradle template already skips
  the plugin without the file. Rebuild after adding it (runbook
  [[build-the-android-app]], "Push").
- **The silent channel is a bundled silent clip** (`res/raw/silence.wav`)
  set as `needs_input`'s sound: neither plugin can create a silent
  high-importance channel otherwise, and a channel's sound is fixed on the
  device once created.
- **`isExactNotification: false`** on every local notification: Android 12+
  otherwise opens the "Alarms & reminders" settings instead of posting.
- **The notifier is seeded, not flooded** (§ 6.5, corrected): the hub
  replays nothing, so `renew()` seeds from the store and `resync()` seeds
  again after `loadSessions()`; a seed never overrides what the hub already
  said.
- **The banner's second line** comes from the upsert that precedes the
  `needs_input` status frame, then the store's session row, then
  `pendingDecisions`; a sessionless failure gets a banner too. The "<title>
  needs input" form keys on the shared `NEEDS_INPUT_BODY`.
- **Returning to the foreground rebuilds the link only when no tunnel is
  up**: with one up, the silence watchdog judges it. The 2a rebuild raced
  a photo's upload after the camera activity returned.
- **"Pair a different Mac" sends an empty push token** to the old relay
  best-effort before dropping the client, so the old Mac's pushes stop; a
  revoke needs nothing. The shared client now sends an empty token.
- **Notification taps and the banner's View respect the gate screens**:
  nothing navigates while unpaired, pairing or on the version mismatch; a
  forget dismisses the banner and clears delivered notifications; opening
  a session clears its own.
- **Errors on the phone are a line under the composer's well**, humanised
  from the Mac's error codes; the phone has no toast surface, does not post
  to `/api/errors` (denied), and ignores the Mac's error-log toasts.
  `/rewind` and `/mcp` are the desktop's and are refused there with a line;
  `/compact` goes to the Mac. A failed question answer or verdict is taken
  back so the card is live again.
- **Ended terminal sessions get a composer**, as on the desktop (a send
  revives them as Orbital sessions); live terminal sessions stay read-only.
- **Plan approval shows no target mode** (9c "Approve → acceptEdits"): the
  decision the Mac sends carries none; the mode is the server's
  `APPROVED_PLAN_MODE`.
- **`PROJECTS_LIMIT` also widens the desktop's stats project filter** from
  50 to every directory the route lists.
- **The Capacitor plugins are listed in `web/package.json` too**, since
  `web/src/mobile` imports them.
- **`MIN_SERVER_VERSION` is `0.18.2`**, the desktop version that ships 2b (the
  defaults route, `lastAt`, `requireDirectory`); a 0.18.1 Mac is refused by
  9i rather than half-working on 9d.

## As built (fidelity pass, 2026-10-05)

The screens were matched to the canvas (9a, 9b, 9d, 9e, 9f, 9h, 9i) on a
real phone. Where the build departs from the canvas, on purpose:

- **9d's model picker wraps four to a row.** The canvas draws one row of
  four segments; the catalog comes from the SDK and lists eleven today.
- **9d's paths print the home folder as `~`** (`homePath`), read off the
  path's shape since the phone never learns the Mac's home; the field and
  the launch keep the full path, and a typed `~/…` matches against it.
- **9e step 1 has no camera feed.** The ML Kit scanner opens over the app,
  so the canvas's camera window is a striped frame reading "TAP TO SCAN",
  which reopens the scanner after it is dismissed.
- **9b's model and mode are labels, and `⋯` is left out**: the phone does
  not switch either yet — [[switch-model-and-mode-from-the-phone]].
- **The notification rows keep the desktop's copy**, not 9f's shorter
  stand-ins: the rows are the desktop's own, in its order.

## Known limits of 2b

- The relay's push is generic; the specific notification needs the phone
  connected (the ADR).
- A notification in flight when the OS kills the socket is lost; the next
  transition is reported by the relay.
- iOS is 2c.
- The deferred minors are in [[mobile-follow-ups]].

## 8. Known limits of 2a

- Wake frames reach only a connected phone: no push until 2b.
- The phone cannot answer anything: no composer, no decisions.
- No iOS build yet; nothing in the code is Android-only.
