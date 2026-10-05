---
id: build-the-ios-app
title: Build and release the iOS app
type: runbook
status: in-force
domain: remote
related:
  - 2026-10-05-ios-app-design
  - build-the-android-app
  - run-the-relay
tags:
  - mobile
  - ios
  - capacitor
---
# Build and release the iOS app

`mobile/ios/` is the Capacitor shell for iOS, beside `mobile/android/`. The
app inside is the same `web/src/mobile` build both platforms load
([[2026-10-05-ios-app-design]]).

## Prerequisites

- **Xcode**, with the owner's Apple account signed in (Xcode → Settings →
  Accounts). Signing is automatic, with the SlothWorks team
  (`DEVELOPMENT_TEAM` in the project, `teamID` in `mobile/ios/ExportOptions.plist`).
- **CocoaPods** (`brew install cocoapods`). The project uses CocoaPods, not
  Swift Package Manager: Google ships ML Kit, which the QR scanner needs,
  only as a pod.
- **A UTF-8 locale.** CocoaPods crashes with `Unicode Normalization not
  appropriate for ASCII-8BIT` when `LANG` is unset. The npm scripts set
  `LANG=en_US.UTF-8`; a `pod install` of your own needs it too.

## Build

```bash
npm run build:ios -w @orbital/mobile   # web mobile build → bundle guard → cap sync ios
npm run ios:open -w @orbital/mobile    # the project in Xcode
```

`cap sync ios` runs `pod install`. A **dev build**
(`ORBITAL_MOBILE_DEV=1 npm run build:ios -w @orbital/mobile`) shows the paste
field beside the scanner and lets the WebView reach a plain-http relay; the
simulator shares the Mac's loopback, so `http://127.0.0.1:4840` works
without any port forwarding.

## The simulator cannot run the scanner

ML Kit ships no arm64 simulator slice, so CocoaPods builds the app for
`x86_64` only, and the iOS 26 simulator refuses an `x86_64` app ("Needs to
Be Updated"). A real iPhone is unaffected. To try the app in the simulator,
build it without the scanner pod, from `mobile/ios/App` — and put the line
back afterwards:

```bash
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
sed -i '' '/CapacitorMlkitBarcodeScanning/d' Podfile && pod install
xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath output/sim build
xcrun simctl boot 'iPhone 17 Pro'
xcrun simctl install booted output/sim/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch --console-pty booted io.slothworks.orbital.mobile
git checkout Podfile && pod install
```

`--console-pty` streams the app's console, Capacitor's bridge calls
included. Pair a dev build through the paste field: start the local stack
from [[build-the-android-app]] → "Pair with a relay on this Mac", open a
code, copy it into the simulator (`xcrun simctl pbcopy booted`), paste it
with ⌘V in the field and accept the request on the Mac.

## Push

Push goes through the same Firebase project as Android (`orbital-sw`) and
the same plugin, `@capacitor-firebase/messaging`, which hands iOS an FCM
token. The relay changes nothing for iOS. Three things are set up once:

1. **An APNs key.** Apple Developer → Certificates, Identifiers & Profiles
   → Keys → +, with Apple Push Notifications service (APNs) on. Download the
   `.p8` (it downloads once) and note its Key ID; the Team ID is
   `XTAS72W86T`.
2. **The iOS app in Firebase.** Project settings → General → Add app → iOS,
   bundle id `io.slothworks.orbital.mobile`. Download
   `GoogleService-Info.plist` into `mobile/ios/App/App/`. It is git-ignored.
   The project does not list it as a resource — a build without it would
   fail — but copies it into the app when it is there (the "Copy
   GoogleService-Info.plist" build phase). The web build reads its presence
   too, so run `build:ios` after adding it.
3. **The key in Firebase**, once the iOS app exists there (the section
   below appears only then): Project settings → Cloud Messaging → Apple app
   configuration → APNs Authentication Key: upload the `.p8` with its Key ID
   and Team ID. One key serves sandbox and production.

Without the file the app builds and runs with no push: the plugin logs
`Firebase was not configured` and the phone never asks for a token.

The project carries the Push Notifications entitlement
(`App/App.entitlements`, `aps-environment` development; the App Store export
switches it to production) and Background Modes → Remote notifications in
`Info.plist`. A push that arrives while the app is open is not shown
(`presentationOptions: []` in `capacitor.config.ts`), as on Android.

The simulator gets no FCM pushes; test them on a device.

## Release to TestFlight

### Once

1. **App Store Connect → Apps → + → New App**: iOS, name Orbital by SlothWorks
   (`Orbital` is taken; the name under the icon is the app's own, `Orbital`),
   bundle id
   `io.slothworks.orbital.mobile` (registered in the developer account by
   Xcode's first automatic signing), a SKU of your choice.
2. **Users and Access**: add each tester as a user of the team, with a role
   of Marketing or above (Marketing is the narrowest that can test), limited
   to this app. Members of the team are **internal** testers: their builds
   need no Beta App Review. An Admin is one already.
3. **TestFlight → Internal Testing → +**: a group with those users and
   automatic distribution on.

### Every release

```bash
npm run ios:release   # from the repo root
```

It runs `build:ios` without `ORBITAL_MOBILE_DEV`, then
`mobile/scripts/ios-release.sh`: `xcodebuild archive` and
`xcodebuild -exportArchive` with `mobile/ios/ExportOptions.plist`, whose
destination `upload` sends the build to App Store Connect through the
account signed in to Xcode.

The version is the Android app's: the script passes `versionName` and
`versionCode` from `mobile/android/app/build.gradle` as `MARKETING_VERSION`
and `CURRENT_PROJECT_VERSION`, so the platforms cannot drift. App Store
Connect refuses a build number it has seen, as Play does, so the same rule
holds: bump `versionCode` before every upload. The values in the Xcode
project matter only for builds run from Xcode.

Apple processes an upload for a few minutes to half an hour; then the build
appears in TestFlight and internal testers get it in the TestFlight app.

`Info.plist` sets `ITSAppUsesNonExemptEncryption` to `false`: the app's
encryption is standard algorithms (`@noble/ciphers`, `@noble/curves`),
which Apple treats as exempt, so App Store Connect does not ask the
export-compliance question for each build.

## Troubleshooting

- **`Unicode Normalization not appropriate for ASCII-8BIT`**: CocoaPods
  without a UTF-8 locale; `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`.
- **`GoogleMLKit/BarcodeScanning … required a higher minimum deployment
  target`**: the Podfile's `platform :ios` and the project's
  `IPHONEOS_DEPLOYMENT_TARGET` must be at least 15.5.
- **"Orbital Needs to Be Updated" when installing on the simulator**: an
  `x86_64` build; see "The simulator cannot run the scanner".
- **`Unable to find a destination matching the provided destination
  specifier`** for a simulator by id: build for
  `generic/platform=iOS Simulator` instead.
- **`Could not delete …/ios/App/build because it was not created by the
  build system`** during `cap sync ios`: something wrote into
  `ios/App/build` by hand (a `-derivedDataPath` or `-archivePath` there).
  Delete the folder; the scripts and this runbook write to `ios/App/output`.
