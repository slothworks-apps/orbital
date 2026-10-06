---
id: build-the-android-app
title: Build and run the Android app
type: runbook
status: in-force
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - run-the-relay
tags:
  - mobile
  - android
  - capacitor
---
# Build and run the Android app

`mobile/` is the Capacitor shell; the app itself is `web/`'s mobile entry
(`web/src/mobile/`), built into `web/dist-mobile/` and copied into the
Android project by `cap sync`.

## Prerequisites

- **Android SDK** with platform-tools, a platform, build-tools and the
  emulator. Android Studio installs it under `~/Library/Android/sdk`, which is
  where `mobile/scripts/android-env.sh` looks when `ANDROID_HOME` is not set.
- **JDK 21 for Gradle.** The system `java` on this Mac is 1.8, which Gradle
  cannot use. The env script takes, in order: `JAVA_HOME` if it is JDK 21
  (an IDE often sets it to its own newer runtime, which is dropped); a JDK 21
  registered with macOS (`/usr/libexec/java_home -F -v 21`); Android Studio's
  bundled JBR at `$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home`
  or `/Applications/Android Studio.app/Contents/jbr/Contents/Home`. Check what
  it picked:

  ```bash
  . mobile/scripts/android-env.sh && echo "$JAVA_HOME" && "$JAVA_HOME/bin/java" -version
  ```

  Installing a separate JDK is optional (`brew install --cask temurin@21`
  registers one with `java_home`); the JBR is enough.
- **An emulator or a device.** `emulator -list-avds` lists the AVDs; this
  Mac has `Samsung_Galaxy_S24_Ultra`. `adb` is on `PATH` from Homebrew; the
  env script also puts the SDK's `platform-tools` and `emulator` on `PATH`.

Every `mobile` script that runs Gradle or `cap run` sources the env script,
so they work from a plain shell. For a command of your own:

```bash
. mobile/scripts/android-env.sh
```

## Build

```bash
npm install                              # once, from the repo root
npm run build -w @orbital/mobile         # web mobile build → bundle guard → cap sync android
npm run apk -w @orbital/mobile           # gradlew assembleDebug
```

The APK is `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
`build` fails if three.js reached the phone's bundle
(`web/src/test/mobilebundle.test.ts`).

A **dev build** (`ORBITAL_MOBILE_DEV=1 npm run build -w @orbital/mobile`)
shows the paste field beside the scanner and lets the WebView reach a
plain-http relay on loopback; use one whenever you pair against a relay on
this Mac.

## Run on the emulator

```bash
. mobile/scripts/android-env.sh
emulator -avd Samsung_Galaxy_S24_Ultra -no-snapshot-save &
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done'
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.slothworks.orbital.mobile/.MainActivity
```

Or build, install and launch in one go:
`npm run run -w @orbital/mobile -- --target Samsung_Galaxy_S24_Ultra`
(`npx cap run android --list` from `mobile/` lists targets).

## Screenshot

```bash
adb exec-out screencap -p > /tmp/orbital-mobile.png
```

## Pair with a relay on this Mac

A throwaway Mac, a local relay and the phone UI, each in its own terminal
(or in the background):

```bash
env -u ORBITAL_MIGRATIONS_DIR -u ORBITAL_STATIC_DIR ORBITAL_PORT=4848 \
  ORBITAL_DATA_DIR=/tmp/orbital-mobile-dev npm run dev -w server
RELAY_PORT=4840 RELAY_DATA_DIR=/tmp/orbital-mobile-relay npm run dev -w relay
T=$(cat /tmp/orbital-mobile-dev/api-token)   # every /api call needs the server's token
curl -s -X PATCH http://127.0.0.1:4848/api/settings -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"remote_enabled":"true","remote_relay_url":"http://127.0.0.1:4840","remote_mac_name":"studio"}'
```

**In a desktop browser:** `ORBITAL_MOBILE_DEV=1 npm run dev:mobile -w @orbital/web`,
open `http://localhost:4841`, then copy a code and paste it into the field:

```bash
curl -s -X POST -H "Authorization: Bearer $T" http://127.0.0.1:4848/api/remote/pair \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).qr))' | pbcopy
```

Accept it on the Mac: `curl -s -H "Authorization: Bearer $T" http://127.0.0.1:4848/api/remote` shows
`pendingPair.phone`; post it to `/api/remote/pair/confirm` as
`{"accept":true,"phone":"<id>"}`.

**On the emulator:** install a dev build (`ORBITAL_MOBILE_DEV=1 npm run build -w @orbital/mobile && npm run apk -w @orbital/mobile`),
launch it, dismiss the system scanner if it opened (`adb shell input keyevent KEYCODE_BACK`),
then `mobile/scripts/pair-emulator.sh 4848`. It reverses the relay port into
the emulator, opens a code, types it into the focused paste field and
accepts the request on the Mac; it reads the server's token from
`ORBITAL_DATA_DIR` (default `/tmp/orbital-mobile-dev`). A real device pairs the same way through
`adb reverse`, or by scanning the code in Settings → Mobile.

To see the other states from the same stack:

- **Mac asleep (9a offline):** stop the server on 4848.
- **Unpaired (9h):** `curl -s -X DELETE -H "Authorization: Bearer $T" http://127.0.0.1:4848/api/remote/devices/<phone id>`.
- **Version mismatch (9i):** restart the server with `ORBITAL_VERSION=0.16.0` in its environment.

Stop everything afterwards: `kill $(lsof -t -iTCP:4848 -sTCP:LISTEN) $(lsof -t -iTCP:4840 -sTCP:LISTEN)`.

## Push

Push runs through the owner's Firebase project, which holds an Android app
with the id `io.slothworks.orbital.mobile`, and through
`@capacitor-firebase/messaging` on the phone, the same plugin iOS uses
([[build-the-ios-app]]). Two files come from it, and
neither is ever committed:

- **`google-services.json`** (Firebase console → Project settings → the
  Android app) goes to `mobile/android/app/google-services.json`. It is
  git-ignored. Gradle applies the Google services plugin only when the file
  exists, and the web build reads its presence too: without it the app asks
  for the notification permission but never asks Firebase for a token, so
  rebuild with `npm run build -w @orbital/mobile` after adding the file, not
  only `apk`.
- **A service-account JSON** (Project settings → Service accounts →
  Generate new private key) goes to the relay as
  `RELAY_FCM_SERVICE_ACCOUNT` ([[run-the-relay]]). Locally it lives in the
  git-ignored `secrets/` at the repo root, as
  `secrets/orbital-relay-fcm.json`; pass an absolute path, the relay's
  `npm run dev` runs from `relay/`.

The Firebase project is `orbital-sw`. Its Cloud Messaging API (V1) must be
enabled (Project settings → Cloud Messaging).

Without either file everything builds and runs: the phone gets no token,
and the relay logs the pushes it would send instead of sending them. A
connected phone posts its own local notifications either way.

The emulator must run a **Google Play** system image to get a token; a
plain AOSP image has no Play services. On first start after pairing, the
app asks for Android 13's notification permission; a denial is not an error
and nothing in the app mentions it.

### Testing a push on the emulator

The relay pushes only to a phone that is offline; a connected phone posts
its own local notification. Start the relay with `RELAY_FCM_SERVICE_ACCOUNT`,
pair, open the app once so it registers its token (the relay's database
holds it in `devices.push_token`), then take the app offline the way the
system does:

```bash
adb shell input keyevent KEYCODE_HOME
adb shell am kill io.slothworks.orbital.mobile
```

**Not `am force-stop`.** A force-stopped app is in Android's stopped state,
and Play services drops its FCM messages: the relay logs `push sent`, FCM
accepts it, and `adb logcat | grep GCM` shows
`broadcast intent callback: result=CANCELLED`. Swiping the app out of
recents does not stop it this way; only force-stop (and Settings → Force
stop) does.

Then make a session the Mac already knows ask for input: start one in mode
`default` that only replies ("Reply with the word ok"), and once it has
answered, send it a message that needs Write. A brand-new session that asks
at once is not news: the Mac's first sighting of it is already
`needs_input`, and a first sighting never notifies. The relay logs `push sent to <token>, count 1` and the
emulator shows "Orbital · <Mac>" / "A session needs your input"; a tap opens
the app on the session list.

The `needs_input` channel is silent. The Capacitor plugins cannot create a
channel without a sound, so the channel plays
`mobile/android/app/src/main/res/raw/silence.wav`, a short silent clip that
must stay in the project. A channel's sound is fixed once a device has
created it: a change to a channel reaches only a fresh install (uninstall
first), and `adb shell dumpsys notification | grep needs_input` shows what a
device holds.

## Release to Google Play

The app ships through the owner's Play Console developer account, today on
the **Internal testing** track: no review, live within minutes, up to 100
testers invited by email.

### The upload key

Play re-signs the app with its own key (Play App Signing); the key here only
proves an upload came from us. Losing it is recoverable — Play support
resets an upload key — but keep a backup with the password anyway.

Create it once, in the git-ignored `secrets/` at the repo root:

```bash
. mobile/scripts/android-env.sh
keytool -genkeypair -v -keystore secrets/orbital-upload.jks -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

Then `secrets/keystore.properties`, which `mobile/android/app/build.gradle`
reads (`storeFile` is relative to `secrets/`):

```properties
storeFile=orbital-upload.jks
storePassword=<the keystore password>
keyAlias=upload
keyPassword=<the key password; keytool's default is the keystore password>
```

Without that file a debug build works as before, and `bundleRelease` stops
with "No upload key" rather than producing an unsigned bundle Play would
refuse.

### Build and upload

```bash
npm run android:release   # from the repo root: build, bundle, upload to Internal testing
npm run android:bundle    # the same without the upload
```

Both run `build` without `ORBITAL_MOBILE_DEV` (a release must never be a dev
build). `android:bundle` then runs `aab` (`gradlew bundleRelease`);
`android:release` runs `play` (`gradlew publishReleaseBundle`), which builds
the same bundle and uploads it to the Internal testing track, rolled out at
once — the Android side of `ios:release`. It needs the service account
below and stops with "No Play service account" without it. Production stays
a release made by hand in the Console.

The bundle is `mobile/android/app/build/outputs/bundle/release/orbital-<versionName>.aab`.
`google-services.json` must be in place before `build`, or the release has
no push ([Push](#push)). A release build reaches only an `https` relay.

Every upload needs a `versionCode` higher than any bundle Play has seen,
including ones never rolled out; bump it with `versionName`
(`mobile/CLAUDE.md`).

### Upload from the command line

The upload goes through the Google Play Developer API with a service
account ([Gradle Play Publisher](https://github.com/Triple-T/gradle-play-publisher),
configured in `mobile/android/app/build.gradle`). Set it up once:

1. Google Cloud Console, any project: enable the **Google Play Android
   Developer API**; IAM → Service accounts → create one (no roles needed);
   Keys → Add key → JSON. Save it as `secrets/play-service-account.json`.
2. Play Console → Users and permissions → Invite new users: the service
   account's e-mail, with the app selected and **Release to testing tracks**
   (and **View app information**). Invitations to service accounts take
   effect at once.
3. The app must already exist with one bundle uploaded by hand: the API
   cannot create an app.

An app that has never been rolled out is a draft and takes only draft
releases: `npm run play -w @orbital/mobile -- -PplayStatus=draft`, then roll
the draft out in the Console.

### Play Console, the first time

1. Create app: Orbital, App, Free. The first bundle fixes the package name
   to `io.slothworks.orbital.mobile`.
2. Testing → Internal testing: a tester list (emails), then a release with
   Play App Signing on and the `.aab`.
3. App content, which the Console asks for before the first rollout: a
   privacy policy URL (the app asks for the camera and notifications), Data
   safety (the app collects nothing; the relay holds a push token and
   encrypted frames it cannot read), content rating, target audience, ads
   (none), and App access (the app needs pairing with a Mac running
   Orbital).
4. Testers join through the opt-in link on the Internal testing page and
   install from Play.

A personal developer account created after November 2023 needs a closed
test with 12 testers over 14 days before it can publish to production;
internal testing has no such gate.

## Troubleshooting

- **The relay logs `push sent` but nothing reaches the emulator**, not even
  `adb logcat | grep -i gcm`: Play services' connection to FCM has gone
  stale (seen after the emulator sat idle). `adb shell cmd connectivity
  airplane-mode enable`, then `disable`, and push again.
- **`Unsupported class file major version` / `requires Java 21`**: Gradle
  ran on the wrong JDK. Source the env script and check `java -version`.
- **`SDK location not found`**: `ANDROID_HOME` is unset and the SDK is not
  at the default path. Export it, or write `sdk.dir=/path/to/sdk` into
  `mobile/android/local.properties` (ignored by git).
- **The scanner is "preparing"**: the Google Barcode Scanner module is
  still downloading through Play services; scan again in a minute. An
  emulator without Play services never gets it — use a dev build's paste field.
- **"The relay refused this code's secret" right after `pair-emulator.sh`**:
  `adb shell input text` sometimes drops a character of the long code (seen:
  `devsecret` arriving as `dvsecret`). Clear the field and run the script
  again.
- **"Can't reach the relay in this code" with a local relay**: `adb reverse`
  was not run in this emulator session, or the build was not a dev build.
