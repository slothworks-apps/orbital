---
id: an-ota-bundle-runs-only-if-signed-by-ci
title: An over-the-air bundle runs only if Orbital's CI signed it
type: adr
status: in-force
domain: mobile
related:
  - 2026-10-09-phone-ota-updates-design
  - ota-updates-through-beam
  - ship-the-phone-over-the-air
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
`@capgo/capacitor-updater` has an encryption scheme that signs the bundle's
session key and checksum with an RSA key. Up to 8.51.22 its Android side
skipped the check when the server sent no session key, comparing a plain
SHA-256 instead.

## Decision

- Every bundle is encrypted and signed in CI with a private key that lives
  only in GitHub's secrets, using the plugin's encryption v2 scheme. The
  public key is built into release builds.
- Beam stores and serves the signed session key and checksum; it cannot
  make a valid one.
- The plugin is pinned exactly at 8.51.25, which refuses a bundle without a
  valid session key whenever a public key is configured, on both platforms.
  No patch is needed; going below 8.51.23 reopens the gap on Android.
- The public key is PKCS#1 (`-----BEGIN RSA PUBLIC KEY-----`): with any other
  header both platforms skip decryption (`CryptoCipher.decryptFile`).
  `capacitor.config.ts` and the signing script refuse anything else.
- Only a release build's shell has the updater on, and it does not build
  without the public key; every other build switches the plugin off.

## As built (2026-10-09)

The patch this ADR first planned turned out to be upstream already. Found by
reading every 8.51.x release's Android source: 8.51.14 to 8.51.22 have no
check, 8.51.23 adds it. In 8.51.25 a public key with an empty or malformed
session key fails the download at every entry point:

- Android: `CapgoUpdater.requireSessionKeyForEncryptedUpdate` (called from
  `finishDownload`, `downloadBackground` and `download`), and
  `DownloadService.handleSingleFileDownload` / `handleManifestDownload`
  before anything is fetched. A non-empty session key then makes
  `decryptChecksum` insist on a 256-byte RSA checksum.
- iOS: `CapgoUpdater.requireSessionKeyForEncryptedUpdate`
  (`CapgoUpdater.swift:464`, called from `download` at line 2110 and
  `downloadManifest` at line 1437), and the auto-update path in
  `CapacitorUpdaterPlugin.swift:4549`.

The scheme the signing script (`scripts/ota-bundle.mjs`) implements, as
both platforms decrypt it: AES-128-CBC with PKCS#7 padding under a random
16-byte key and IV; `session_key` = `<IV base64>:<AES key RSA-encrypted
with the private key, PKCS#1 v1.5, base64>`; `checksum` = the SHA-256 of
the plain zip, RSA-encrypted the same way, hex. Its tests mirror the
plugin's decryption step by step.

## Alternatives

- **A signature of our own, verified natively before activation.** Beam
  reserves `publicKey` and `signature` for it. It means native code on both
  platforms that hooks the plugin's install path, for the same guarantee
  the plugin's scheme gives once the Android gap is closed.
- **No signing while only internal testers have the app.** A compromised
  Beam would then reach testers' Macs; the idea ruled it out from the start.
