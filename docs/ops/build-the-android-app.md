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
  cannot use. The env script takes, in order: `JAVA_HOME` if set; a JDK 21
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
curl -s -X PATCH http://127.0.0.1:4848/api/settings -H 'content-type: application/json' \
  -d '{"remote_enabled":"true","remote_relay_url":"http://127.0.0.1:4840","remote_mac_name":"studio"}'
```

**In a desktop browser:** `ORBITAL_MOBILE_DEV=1 npm run dev:mobile -w @orbital/web`,
open `http://localhost:4841`, then copy a code and paste it into the field:

```bash
curl -s -X POST http://127.0.0.1:4848/api/remote/pair \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).qr))' | pbcopy
```

Accept it on the Mac: `curl -s http://127.0.0.1:4848/api/remote` shows
`pendingPair.phone`; post it to `/api/remote/pair/confirm` as
`{"accept":true,"phone":"<id>"}`.

**On the emulator:** install a dev build (`ORBITAL_MOBILE_DEV=1 npm run build -w @orbital/mobile && npm run apk -w @orbital/mobile`),
launch it, dismiss the system scanner if it opened (`adb shell input keyevent KEYCODE_BACK`),
then `mobile/scripts/pair-emulator.sh 4848`. It reverses the relay port into
the emulator, opens a code, types it into the focused paste field and
accepts the request on the Mac. A real device pairs the same way through
`adb reverse`, or by scanning the code in Settings → Mobile.

To see the other states from the same stack:

- **Mac asleep (9a offline):** stop the server on 4848.
- **Unpaired (9h):** `curl -s -X DELETE http://127.0.0.1:4848/api/remote/devices/<phone id>`.
- **Version mismatch (9i):** restart the server with `ORBITAL_VERSION=0.16.0` in its environment.

Stop everything afterwards: `kill $(lsof -t -iTCP:4848 -sTCP:LISTEN) $(lsof -t -iTCP:4840 -sTCP:LISTEN)`.

## Troubleshooting

- **`Unsupported class file major version` / `requires Java 21`**: Gradle
  ran on the wrong JDK. Source the env script and check `java -version`.
- **`SDK location not found`**: `ANDROID_HOME` is unset and the SDK is not
  at the default path. Export it, or write `sdk.dir=/path/to/sdk` into
  `mobile/android/local.properties` (ignored by git).
- **The scanner is "preparing"**: the Google Barcode Scanner module is
  still downloading through Play services; scan again in a minute. An
  emulator without Play services never gets it — use a dev build's paste field.
- **"Can't reach the relay in this code" with a local relay**: `adb reverse`
  was not run in this emulator session, or the build was not a dev build.
