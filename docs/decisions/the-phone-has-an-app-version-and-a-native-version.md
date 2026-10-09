---
id: the-phone-has-an-app-version-and-a-native-version
title: The phone has an app version and a native version
type: adr
status: in-force
domain: mobile
related:
  - 2026-10-09-phone-ota-updates-design
  - a-version-ships-once-from-one-workflow
  - a-shipped-version-never-goes-back
tags:
  - mobile
  - release
---
# The phone has an app version and a native version

## Context

Until over-the-air updates the phone had one version: `versionName` in
`build.gradle`, copied to `mobile/package.json` and Xcode, and every bump
was a store build. With OTA most phone changes ship as a bundle, and only a
change to the native shell needs the stores
([[2026-10-09-phone-ota-updates-design]]). Releases ship only on a version
bump ([[a-version-ships-once-from-one-workflow]]), so each path needs a
version of its own.

## Decision

- The **app version**, `version` in `mobile/package.json`, goes up with
  every change that reaches the phone and ships a bundle through Beam. The
  Mac's compatibility check and the phone's `hello` use it.
- The **native version**, `versionName`/`versionCode` in `build.gradle` and
  its Xcode copies, goes up only for a change a bundle cannot carry and
  ships a store build. A native bump bumps the app version too.
- The app version is never lower than the native one;
  `check-versions.mjs` enforces it.

## Alternatives

- **A bundle on every merge, versioned `<native>.<stamp>`** — fewer bumps,
  but something new would ship without a version saying so, which the
  release rules rule out.
- **One version for both** — every fix would be a store build again.
