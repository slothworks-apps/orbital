---
id: ota-updates-through-beam
title: Over-the-air updates for the phone app through Beam
status: backlog
type: idea
domain: mobile
related:
  - demo-mode-for-store-review
  - 2026-10-05-ios-app-design
tags:
  - mobile
  - release
---
# Over-the-air updates for the phone app through Beam

Once the phone app is public, every fix has to pass App Store and Google
Play review before it reaches anyone. The app is a Capacitor shell around
`web/src/mobile`, so nearly every change is a change to its web bundle,
and a web bundle can be shipped over the air. Slothworks' own OTA server,
Beam, already serves Capacitor apps through the `@capgo/capacitor-updater`
plugin. It publishes from CI, gates bundles by the minimum native version,
rolls back in one click and counts which version each device runs.

## The idea

- The phone app gets the updater plugin, pointed at Beam, and calls
  `notifyAppReady()` once the app has started. A bundle that never calls
  it is reverted by the plugin.
- A release job builds `web/src/mobile` and publishes the bundle to Beam
  with the app's upload key, versioned `<versionName>.<stamp>` and with
  `minNativeVersion` set to the first native build it can run on.
- The plugin has to be in the first public build. Without it, bugs in that
  build can only be fixed through store review.

## Conditions

- **Signed bundles before anything ships.** The phone holds the pairing
  keys and sends commands to a Mac that runs Claude with a shell. Whoever
  controls Beam or the upload key could otherwise push code to every phone
  that sends those keys away or acts on the Mac, and the relay's blindness
  would mean nothing. The app must verify each bundle against a public key
  built into the native binary, so a compromised server is not enough.
  Beam reserves `publicKey` and `signature` for this, but does not use
  them yet.
- **OTA carries everything that is not native.** Fixes and new features
  ship over the air; only a change that needs a native plugin, a new
  permission or a manifest / `Info.plist` change waits for a store build.
  Google Play allows this outright: its rule against downloaded code
  exempts JavaScript running in a webview. Apple is the risk. Guideline
  2.5.2 forbids downloaded code that "introduces or changes features",
  while the developer agreement (§3.3.1(B)) allows interpreted code that
  does not change the app's primary purpose. In practice Apple enforces
  the second, which is how Expo Updates and Capgo users ship features. So
  the limits are:
  - a feature stays within what the store listing says the app is: a
    remote for Claude Code sessions on the user's Mac;
  - nothing is held back during review and switched on after it;
  - a store build follows every so often, so the bundle built into the
    binary does not fall far behind what devices run.
- **Off in dev builds and in forks.** The update URL and the public key
  come from the release build's configuration, not from the repository.
- **Beam's first consumer goes first.** Beam's app-side integration is
  still open for Ergaily. Orbital should follow once that runs.

## What changes in the repository's rules

- The versions table in `CLAUDE.md` gains the bundle version, and a rule
  for when a change can ship over the air and when it needs a store build
  (a native plugin, a permission or an `Info.plist` / manifest change
  always needs a store build).
- `mobile/CHANGELOG.md` records over-the-air releases too.
