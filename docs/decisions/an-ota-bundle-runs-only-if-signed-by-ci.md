---
id: an-ota-bundle-runs-only-if-signed-by-ci
title: An over-the-air bundle runs only if Orbital's CI signed it
type: adr
status: in-force
domain: mobile
related:
  - 2026-10-09-phone-ota-updates-design
  - ota-updates-through-beam
tags:
  - mobile
  - security
  - release
---
# An over-the-air bundle runs only if Orbital's CI signed it

## Context

The phone holds the pairing keys and sends commands to a Mac that runs
Claude with a shell. Over-the-air updates let a server replace the code the
phone runs ([[2026-10-09-phone-ota-updates-design]]). Whoever controls that
server, or its upload key, must not be able to push code to phones.

Beam, the update server, checks only a plain SHA-256: it guards against a
broken download, not against a hostile server. The plugin
`@capgo/capacitor-updater` (8.51.x) has an encryption scheme that signs the
bundle's session key and checksum with an RSA key, but on Android it skips
the check when the server sends no session key.

## Decision

- Every bundle is encrypted and signed in CI with a private key that lives
  only in GitHub's secrets, using the plugin's encryption v2 scheme. The
  public key is built into release builds.
- Beam stores and serves the signed session key and checksum; it cannot
  make a valid one.
- The Android plugin is patched (`patch-package`) to refuse a bundle with
  no session key when a public key is configured; the fix is offered
  upstream. iOS already refuses.

## Alternatives

- **A signature of our own, verified natively before activation.** Beam
  reserves `publicKey` and `signature` for it. It means native code on both
  platforms that hooks the plugin's install path, for the same guarantee
  the plugin's scheme gives once the Android gap is closed.
- **No signing while only internal testers have the app.** A compromised
  Beam would then reach testers' Macs; the idea ruled it out from the start.
