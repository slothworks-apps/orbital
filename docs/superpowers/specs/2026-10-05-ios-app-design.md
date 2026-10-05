---
id: 2026-10-05-ios-app-design
title: The phone app on iOS, through TestFlight
status: done
type: spec
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - build-the-android-app
  - run-the-relay
tags:
  - mobile
  - ios
  - capacitor
  - push
---
# The phone app on iOS, through TestFlight

## Why

The phone app runs on Android only, which leaves out everyone who carries
an iPhone. The app is
`web/src/mobile` inside a Capacitor shell, and Capacitor builds for iOS from
the same web code, so this is a second shell, not a second app.

The owner has a paid Apple Developer Program membership, so the build goes
to TestFlight, to **internal** testers — members of the App Store Connect
team: no Beta App Review, a build is installable as soon as Apple has
processed it.

## Behaviour

On an iPhone the app does what it does on Android: pair by scanning the
Mac's QR code (or pasting the code in a dev build), list the Mac's
sessions, read and write a session, start a new one, and be told by a push
when a session needs input while the app is not open.

What differs, and why:

- **No notification channels.** iOS has none. Android's two channels
  (`needs_input` silent, `needs_input_sound`) stay Android-only. On iOS the
  relay's push arrives without a sound because the relay's message names
  none; local notifications follow the phone's `sound` rule per
  notification, as they already do.
- **Permission prompts.** iOS asks for notifications, the camera and the
  photo library through its own system dialogs; their explanatory texts
  live in `Info.plist`. A denial is not an error, as on Android.
- **Backgrounding.** iOS suspends the WebView soon after the app leaves the
  foreground. The app's existing reconnect on return to the foreground
  covers it; nothing runs in the background, as on Android.

## Shape of the change

### The iOS project

`mobile/ios/`, created by `cap add ios`, committed like `mobile/android/`.
Bundle id `io.slothworks.orbital.mobile`, display name Orbital, iPhone only
(`TARGETED_DEVICE_FAMILY` 1), iOS 15.5 at least (ML Kit's floor). The icon
and splash are Capacitor's placeholders, as on Android today.

Native dependencies come through **CocoaPods**, not Swift Package Manager:
Google ships ML Kit, which the QR scanner
(`@capacitor-mlkit/barcode-scanning`) needs, only as CocoaPods. CocoaPods is
installed on the owner's Mac (Homebrew).

Two consequences of ML Kit:

- **No simulator with the scanner.** ML Kit has no arm64 simulator slice,
  so the pods build the simulator app for `x86_64`, which the iOS 26
  simulator refuses. The runbook gives a throwaway recipe that drops the
  scanner pod for a simulator build; a real iPhone is unaffected.
- **Firebase leaves CocoaPods.** Firebase publishes no new pods after
  October 2026; the pods in use keep working. Moving Firebase to SPM while
  ML Kit stays on pods, or replacing ML Kit, is a later job
  ([[firebase-ios-leaves-cocoapods]]).

Capabilities: Push Notifications, and Background Modes → Remote
notifications (required for FCM to deliver to a suspended app). Signing is
automatic, with the owner's team.

`Info.plist` carries:

- `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` — the
  scanner and photos sent to a session;
- `ITSAppUsesNonExemptEncryption` = `false`, so App Store Connect does not
  ask the export-compliance question on every build. The app encrypts its
  traffic with standard algorithms (`@noble/ciphers`, `@noble/curves`),
  which Apple's questionnaire treats as exempt; **the owner confirms this
  declaration** — it is made to Apple in their name.

`GoogleService-Info.plist` (Firebase console → the iOS app) goes to
`mobile/ios/App/App/`, git-ignored like `google-services.json`. The project
cannot list a git-ignored file as a resource — a build without it would
fail — so a build phase copies it into the app when it is there. One web
build serves both shells, so `__MOBILE_PUSH__` is per platform
(`{ android, ios }`, each true when that project's Firebase file exists)
and the phone reads its own.

### Push through one plugin on both platforms

`@capacitor/push-notifications` hands Android an FCM token but iOS an APNs
device token, which the relay's FCM sender cannot address. The app moves to
`@capacitor-firebase/messaging`, which returns an FCM token on both. The
relay does not change: it keeps sending FCM v1 messages, whose `apns`
block it already fills.

Both plugins cannot stay installed: each declares its own Firebase
messaging service on Android, and only one receives the messages. So
Android moves too, and `web/src/mobile/platform/push.ts` and
`localNotify.ts` switch plugins:

| today (`@capacitor/push-notifications`) | after (`@capacitor-firebase/messaging`) |
|---|---|
| `requestPermissions` → `receive` | `requestPermissions` → `receive` |
| `register` + `registration` listener | `getToken` + `tokenReceived` listener |
| `pushNotificationActionPerformed` | `notificationActionPerformed` |
| `createChannel` | `createChannel`, Android only |
| `removeAllDeliveredNotifications` | `removeAllDeliveredNotifications` |

The Firebase web SDK, an optional peer of the plugin, is not installed: the
app uses the plugin only inside the native shell. The plugin's web
implementation still imports it, so the phone's Vite build aliases
`firebase/messaging` to a stub that reports push as unsupported.

Two behaviours the plugin swap has to keep:

- **A push to an open app is not shown.** Android's FCM SDK does not show
  a notification message in the foreground; on iOS the plugin's
  `presentationOptions` is set to `[]` for the same result. The relay
  pushes only to a phone it sees offline anyway.
- **The `sound` rule on iOS.** With no channels, a local notification
  carries its own sound: none unless the rule is on, then the system
  default (`LocalNotice.sound`).

The owner's one-time setup for iOS push, written into the runbook: an APNs
authentication key (`.p8`) from the Apple Developer account, uploaded to
the Firebase project `orbital-sw` (Project settings → Cloud Messaging →
Apple app configuration), and an iOS app registered in that project.

### Build and upload

`npm run ios:release` at the repo root, next to `android:release`:
the web mobile build without `ORBITAL_MOBILE_DEV`, `cap sync ios`,
`xcodebuild archive`, then `xcodebuild -exportArchive` with an
`ExportOptions.plist` whose destination is `upload`, which sends the build
to App Store Connect with the Xcode account the owner is signed in with.
`npm run ios:open` opens the project in Xcode for anything done by hand.

The App Store Connect record (bundle id, name) is created by the owner once,
by hand.

### Versions and changelog

The iOS app is the same app as the Android one, built from the same code,
so it carries the same version. The release script passes `versionName`
and `versionCode` from `build.gradle` to Xcode as `MARKETING_VERSION` and
`CURRENT_PROJECT_VERSION`, so a bump is one edit and the platforms cannot
drift. `mobile/CHANGELOG.md` covers both; a line that applies
to one platform only says so. The root `CLAUDE.md` versions table and
`mobile/CLAUDE.md` say this.

### Runbook

`docs/ops/build-the-ios-app.md`: prerequisites, the simulator, the
owner's one-time setup (App Store Connect record, APNs key into Firebase,
`GoogleService-Info.plist`), `ios:release`, and adding an internal tester
in TestFlight.

## Phone

This is the phone. The routes, WS topics and allowlist do not change; an
iPhone reaches the Mac exactly as an Android phone does. The relay stores
the device's `platform` (`ios`) as it already does for `android`.

## Testing

- The typecheck and the mobile bundle guard, as today.
- The iOS simulator: build, launch, pair against a local relay through the
  paste field of a dev build, read and write a session, return from the
  background. The simulator cannot receive FCM pushes.
- The Android emulator, because its push plugin changes: a push to an
  offline app arrives on the silent channel and a tap opens the list, as the
  runbook's "Testing a push on the emulator" describes.
- A real iPhone through TestFlight for push, done by the owner.

No new automated tests: the change is native configuration and a plugin
swap behind the same three functions.

## Out of scope

- App Store release (beyond TestFlight).
- iPad layout.
- A relay that talks to APNs directly.
