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

Task 9 of the 2a plan adds this section, with the script that types a pairing code into the emulator.

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
