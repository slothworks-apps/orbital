---
id: 2026-10-03-mobile-remote-handoff
title: "Mobile remote — handoff after phase 2b and the relay secret (next: relay deployment, iOS)"
type: session
status: active
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - the-connected-phone-notifies-itself
  - the-relay-takes-a-shared-secret
  - build-the-android-app
  - run-the-relay
  - mobile-follow-ups
tags:
  - mobile
  - relay
  - handoff
---
# Mobile remote — handoff (2026-10-03)

The working state a fresh session needs to continue the mobile remote.
Written because the chat's own compaction cannot carry it.

## State in local `main` (nothing pushed)

- **Phase 2b** (merge `6d9a5a5` + `ba15cdd`, desktop 0.18.2): the phone
  writes through the shared Tiptap composer, sends camera/gallery photos
  (downscaled to 1568 px, uploaded with `putBlob`), answers permission,
  plan and question cards, starts a new session (9d), registers for push,
  posts local notifications and shows the 9g banner. `MIN_SERVER_VERSION`
  is 0.18.2.
- **Relay secret** (merge `f6788fd`, desktop 0.18.3): `RELAY_SECRET` in the
  relay's env (unset = open), a "Relay secret" field in Settings → Mobile →
  ADVANCED, the secret travels to the phone in the pairing QR. A refusal is
  401 `bad_secret` on the pairing routes and WebSocket close 4003; a phone
  with a stored pairing lands on 9h, a refusal during pairing returns to
  the scanner with a line.
- **2c (iOS, TestFlight)** is deferred; Xcode 26.6 and CocoaPods are
  installed on the owner's Mac.
- The main checkout holds another session's untracked
  `docs/superpowers/specs/2026-10-02-harness-redesign-design.md`; every
  worktree was removed.

## Read first

- [[2026-10-02-mobile-app-design]] § 6.5 (push and notifications), "As
  built (2b)" (the `__MOBILE_PUSH__` build flag, the `silence.wav` channel,
  `isExactNotification`, the seeded notifier) and "Known limits of 2b".
- [[the-connected-phone-notifies-itself]] and
  [[the-relay-takes-a-shared-secret]].
- [[build-the-android-app]] § Push (`google-services.json` into
  `mobile/android/app/`, git-ignored; Gradle applies the plugin only when
  the file exists; after adding it run `npm run build -w @orbital/mobile`,
  not only `apk`) and [[run-the-relay]] (Dokploy: Postgres,
  `RELAY_DATABASE_URL`, `RELAY_TRUST_PROXY=1`, a long random
  `RELAY_SECRET`, `RELAY_FCM_SERVICE_ACCOUNT` as a mounted file; rotation).
- `relay/src/push.ts` (`FcmPushSender`: service-account JWT → bearer, POST
  `fcm.googleapis.com/v1/projects/<project_id>/messages:send`, a
  notification message with `android.notification.channel_id`
  `needs_input` and a collapse key; `LogPushSender` only logs without a
  service account), `relay/src/config.ts`, `relay/src/index.ts`.
- `web/src/mobile/platform/push.ts` (`requestPermissions`, `register`,
  `registration` → `clientRef.pushToken`; channels `needs_input`, silent
  through `res/raw/silence.wav`, and `needs_input_sound`),
  `web/src/mobile/notify.ts`, `web/src/mobile/boot.ts`,
  `web/vite.mobile.config.ts` (`__MOBILE_PUSH__` from the presence of
  `google-services.json`), `mobile/android/app/build.gradle` (the
  conditional google-services plugin), `mobile/scripts/android-env.sh`,
  `mobile/scripts/pair-emulator.sh`.
- [[mobile-follow-ups]] (deferred minors: no rate limit on a refused
  WebSocket auth, cards stay tappable while the Mac sleeps,
  `Camera.getPhoto` deprecated, and more).

## Done: Firebase for push (2026-10-03)

Firebase project `orbital-sw`; `google-services.json` and
`secrets/orbital-relay-fcm.json` are in place (both git-ignored). Tested on
the emulator: token registered, the relay logged `push sent`, the generic
notification appeared and a tap opened the session list. Kill the app with
`am kill`, not `am force-stop` — see [[build-the-android-app]] § Testing a
push on the emulator. The steps as they were done:

1. Firebase console → Add project (Analytics off).
2. Add an Android app with package name `io.slothworks.orbital.mobile`;
   download `google-services.json` → `mobile/android/app/google-services.json`
   (git-ignored; never committed).
3. Project settings → Service accounts → Generate new private key → a JSON
   kept in the git-ignored `secrets/` at the repo root (for example `secrets/orbital-relay-fcm.json`);
   locally `RELAY_FCM_SERVICE_ACCOUNT=<path>` when starting the relay, on
   Dokploy a secret file with its path in that variable.
4. Project settings → Cloud Messaging: "Firebase Cloud Messaging API (V1)"
   must be enabled.
5. Build and test: `ORBITAL_MOBILE_DEV=1 npm run build -w @orbital/mobile
   && npm run apk -w @orbital/mobile`, `adb install -r` on the emulator
   `Samsung_Galaxy_S24_Ultra` (its `google_apis` image has Play services,
   enough for FCM), pair through `mobile/scripts/pair-emulator.sh 4848`,
   kill the app (not merely background it — a connected phone gets a local
   notification, the relay pushes only to an offline phone), trigger
   `needs_input` on the Mac (a session in mode `default` with a Write
   prompt, or an AskUserQuestion prompt), expect `push sent` in the relay's
   log and the generic notification "Orbital · <Mac>: A session needs your
   input" on the emulator.

Dev stack: relay `RELAY_PORT=4840 RELAY_DATA_DIR=/tmp/<x> RELAY_SECRET=<s>
RELAY_FCM_SERVICE_ACCOUNT=<path> npm run dev -w relay`; Mac `env -u
ORBITAL_MIGRATIONS_DIR -u ORBITAL_STATIC_DIR ORBITAL_PORT=4848
ORBITAL_DATA_DIR=/tmp/<y> npm run dev -w server`; then `PATCH
/api/settings` with `remote_enabled`, `remote_relay_url`,
`remote_relay_secret`, `remote_mac_name`.

## After that

- Phase 3: deploy the relay on Hetzner/Dokploy per [[run-the-relay]]; set
  the relay URL and secret in Settings → Mobile.
- 2c: the iOS project and TestFlight.

## Working rules that still bind

Orbital-only features; `ORBITAL_*` variables in the session break the dev
server (`env -u ORBITAL_MIGRATIONS_DIR`); other sessions edit the main
checkout and switch its branch (check `git branch --show-current` in the
same command as a merge); subagents write only inside the session's
worktree (Opus for complex work, Sonnet for small reviews, never the
default); chat in Czech, documents in English, choices through
AskUserQuestion, longer summaries as a separate message.
