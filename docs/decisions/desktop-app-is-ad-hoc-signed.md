---
id: desktop-app-is-ad-hoc-signed
title: The desktop app is ad-hoc signed, not unsigned
type: adr
status: in-force
domain: desktop
related:
  - 2026-09-16-electron-wrapper-design
  - trim-and-sign-the-desktop-package
  - run-the-desktop-app
tags:
  - desktop
  - electron
  - packaging
  - notifications
---
# The desktop app is ad-hoc signed, not unsigned

## Context

Spec `2026-09-16-electron-wrapper-design` § 4 step 1 ships an unsigned DMG,
and `desktop/electron-builder.yml` implemented that with `mac.identity: null`.
That setting makes electron-builder skip signing altogether. The bundle then
still carries a signature, but not one for the app. It is the linker's
signature on the stock Electron binary: `Identifier=Electron`,
`Info.plist=not bound`, `Sealed Resources=none`. `spctl` rejects it with
*"code has no resources but signature indicates they must be present"*.

macOS keys notification permission to the app's bundle identifier
(`io.slothworks.orbital`) and checks it against the code signature. With a
signature that names neither, the request is refused silently. No prompt
appears, Orbital never gets a row under System Settings → Notifications, and
`usernoted` logs nothing about it. No notification ever reached the user,
although the notifier and the feed behind it worked.

## Decision

`mac.identity: "-"`. electron-builder then ad-hoc signs the whole bundle
(`Identifier=io.slothworks.orbital`, Info.plist bound, resources sealed,
`codesign --verify --deep --strict` passes). This needs no certificate and no
Apple Developer account.

electron-builder warns that ad-hoc signing with hardened runtime needs
`com.apple.security.cs.disable-library-validation`. Its default entitlements
already include it, so the warning needs no action. The packaged app launches
and serves `/api/health`.

## Ruled out

- **Leaving `identity` unset.** electron-builder would pick the keychain's
  *Apple Development* certificate. It is not a distribution identity, and on
  another Mac it fails in a way that is harder to read than Gatekeeper's
  quarantine prompt. This was the reason for `null` in the first place, and it
  still holds.
- **Developer ID signing and notarization now.** They are still the plan
  (chore `trim-and-sign-the-desktop-package`), but notifications do not need
  them. An ad-hoc signature is enough for the permission prompt on the Mac
  that runs the app.

## Consequences

- On another Mac the DMG is still quarantined like any app that is not
  notarized. The first launch still needs right-click → Open, or
  `xattr -d com.apple.quarantine`.
- An ad-hoc signature changes with every build. macOS may therefore ask for
  notification permission again after an update.
