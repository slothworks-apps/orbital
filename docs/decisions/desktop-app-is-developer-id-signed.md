---
id: desktop-app-is-developer-id-signed
title: The desktop app is signed with Developer ID and notarized
type: adr
status: in-force
domain: desktop
related:
  - desktop-app-is-ad-hoc-signed
  - trim-and-sign-the-desktop-package
  - run-the-desktop-app
tags:
  - desktop
  - electron
  - packaging
---
# The desktop app is signed with Developer ID and notarized

Supersedes `desktop-app-is-ad-hoc-signed`.

## Context

Orbital kept asking for privacy access: the Downloads folder, the Apple Music
library, and similar. There are two reasons, and both apply at once.

1. **What asks is a Claude session, not Orbital.** The `claude` CLI and every
   command it runs (`ls`, `find`, a build script) are children of Orbital.app.
   macOS charges their access to the responsible app, which is Orbital. A
   session that walks the home directory touches Downloads, Documents and the
   media library, and each of those gets its own prompt. A session run in a
   terminal triggers the same prompts, but there they name the terminal, which
   was granted long ago.
2. **An ad-hoc signature changes with every build.** macOS records a grant
   against the app's designated requirement. For an ad-hoc signature that is
   the code hash, so each new DMG is a different app to macOS, and every grant
   was forgotten on update.

## Decision

- `mac.identity` names the Developer ID Application certificate of SlothWorks
  s.r.o. (team `XTAS72W86T`). The designated requirement then becomes the team
  and the bundle id, which survive a rebuild, and so do the grants.
- `hardenedRuntime: true` with electron-builder's default entitlements
  (`allow-jit`, `allow-unsigned-executable-memory`,
  `disable-library-validation`). Notarization requires the hardened runtime.
- The `dist` script sets `APPLE_KEYCHAIN_PROFILE` (default `orbital-notary`),
  so every release is notarized with credentials stored by `xcrun notarytool
  store-credentials`. No password is kept in the repository or in the
  environment.
- An `afterSign` hook (`desktop/build/verify-signature.cjs`) fails the build
  when the bundle is not signed as configured. If the identity is missing from
  the keychain, electron-builder only logs "skipped macOS application code
  signing" and ships an unsigned bundle. That is the bundle whose notification
  permission macOS refused silently.
- `Info.plist` carries usage descriptions for the folder and media prompts.
  They tell the user that a Claude session is asking, not Orbital itself.

## Ruled out

- **A self-signed certificate.** It would keep grants stable on the build
  machine, but not notarize, and another Mac would still quarantine the app.
  With a Developer account available, it only adds a certificate to maintain.
- **Leaving `identity` unset.** electron-builder could fall back to the
  *Apple Development* certificate, which is not a distribution identity.
- **Preventing the prompts.** A non-sandboxed app cannot pre-authorize
  Downloads or Documents access. Only the user can grant it, in the prompt or
  under Full Disk Access. Signing makes that a one-time answer.

## Consequences

- The first Developer ID build is a new identity to macOS. Grants given to the
  ad-hoc builds do not carry over and are asked for once more.
- Packaging needs the certificate and the notary profile in the keychain.
  Runbook `run-the-desktop-app` has the setup and the ad-hoc escape hatch for a
  machine that has neither.
- A notarized DMG opens without the right-click → Open step on another Mac.
