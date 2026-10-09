---
id: 2026-10-09-phone-ota-updates-design
title: The phone app updates over the air, from signed bundles through Beam
status: active
type: spec
domain: mobile
related:
  - ota-updates-through-beam
  - 2026-10-08-release-roadmap
  - 2026-10-08-builds-for-testers-design
  - a-version-ships-once-from-one-workflow
  - an-ota-bundle-runs-only-if-signed-by-ci
  - the-phone-has-an-app-version-and-a-native-version
  - 2026-10-07-version-compatibility-design
  - build-the-ios-app
  - build-the-android-app
tags:
  - mobile
  - release
  - security
---
# The phone app updates over the air, from signed bundles through Beam

Phase 3 of [[2026-10-08-release-roadmap]], moved ahead of the phone's first
release to testers: a fix to `web/src/mobile` should reach testers' phones
without a store build, and the first build in their hands should already
take it. Built from the idea [[ota-updates-through-beam]].

## What changes for the user

- A tester's phone downloads a new version of the app in the background and
  offers it with a quiet prompt; **Restart** switches to it at once,
  closing the prompt uses it at the next cold start.
- Only a bundle signed by Orbital's CI ever runs. A bundle that fails to
  start is rolled back on its own.
- Settings shows the app's version and the native shell's
  (`0.7.3 · shell 0.7.0`).

## Decisions taken while designing

- **Everything runs on our side.** The open-source plugin
  `@capgo/capacitor-updater` in self-hosted mode talks only to Beam
  (`https://beam.slothworks.io`), Slothworks' own update server. No Capgo
  service or account is used.
- **One Beam app**, `io.slothworks.orbital.mobile`, for internal testers now
  and the public later. Testers are the staging. Beam promotes an uploaded
  bundle to every device at once; the guard is a one-click rollback in
  Beam's admin.
- **Signed with Capgo's encryption v2, plus a plugin patch**
  ([[an-ota-bundle-runs-only-if-signed-by-ci]]).
- **Two phone versions** — the app (bundle) version ships over the air, the
  native version through the stores
  ([[the-phone-has-an-app-version-and-a-native-version]]).
- **Stats at level 2:** a random install id, the device model, OS, versions
  and install results. No name, no custom id.
- **The update is offered, not applied silently**, like the desktop app's.

## Signing

- A 2048-bit RSA key pair, made once by the maintainer. The private key is
  the GitHub secret `OTA_PRIVATE_KEY` and nowhere else. The public key is
  committed (`mobile/ota-public-key.pem`) and built into release builds as
  `plugins.CapacitorUpdater.publicKey`.
- CI zips the built bundle (`index.html` at the zip root), encrypts it with
  a random AES-128-CBC key, and signs with the private key what the plugin
  verifies: the session key (`<iv>:<RSA-encrypted AES key>`) and the
  checksum. This is the plugin's own encryption v2 scheme; the encryption
  is done by a script in `scripts/` with Node's `crypto`, not by Capgo's
  CLI, and is tested against the plugin's decryption rules (a bundle
  encrypted by the script decrypts with the public key; one altered or
  signed with another key does not).
- **Android patch** (not needed in the end, see As built). Plugin 8.51.x on Android accepts a bundle that comes
  without a session key even when a public key is configured, comparing a
  plain SHA-256. A server that drops the session key would run unsigned
  code. `mobile/patches/` (`patch-package`) makes it refuse such a bundle:
  with a public key set, no session key means a failed download. The same
  fix is offered upstream. iOS already refuses.
- Dev builds (`ORBITAL_MOBILE_DEV`) and forks get no `updateUrl`,
  `statsUrl` or `publicKey`; the updater stays off. Only the release build's
  configuration adds them.

## Beam

Beam's own repository changes first, as its own pull request, deployed
before Orbital's OTA job runs:

1. Upload (`POST /api/apps/:appId/bundles`) accepts `sessionKey` and a
   signed `checksum` for an encrypted bundle; Beam stores them and returns
   them in `POST /api/updates` (`session_key`, `checksum`) instead of its own
   SHA-256. A bundle uploaded without them behaves as today, so Ergaily is
   unaffected.
2. `GET /api/apps/:appId/bundles/:version`, behind the app's upload key:
   200 when that version is uploaded, 404 when not. `release-plan` asks it.
3. Stats take the device model (an optional field on the stats event) and
   the admin shows it per install with OS, version and last seen.
4. Fix: `PromoteDto.bundleId` is validated as a UUID but bundle ids are
   Mongo ObjectIds, so Promote in the admin fails.

## Versions

- **App version** — `version` in `mobile/package.json` (and its copy in
  `package-lock.json`). Every change that reaches the phone bumps it: a
  change under `mobile/`, in `web/src/mobile` and what it imports, or in
  `shared/`. It is what `__MOBILE_VERSION__` carries, what the phone's
  `hello` tells the Mac, and what [[2026-10-07-version-compatibility-design]]
  compares.
- **Native version** — `versionName` / `versionCode` in
  `mobile/android/app/build.gradle` and `MARKETING_VERSION` /
  `CURRENT_PROJECT_VERSION` in the Xcode project. It goes up only for a
  change the bundle cannot carry: a native plugin, a permission, an
  `Info.plist` or manifest change, a Capacitor upgrade. A native bump bumps
  the app version too.
- `scripts/check-versions.mjs` checks: the native copies agree; the app
  version is not lower than the native one; with `--base`, neither goes
  down, and a new `versionName` still needs a higher `versionCode`.
- The root `CLAUDE.md` versions table and `mobile/CLAUDE.md` get the rule.
  `mobile/CHANGELOG.md` is kept per app version; a line for a native change
  says it needs the store update.

## Releasing

`release-plan` gains the app version:

| item | version from | shipped when |
|---|---|---|
| desktop | `desktop/package.json` | a GitHub Release `v<version>` is published |
| **phone app (OTA)** | `mobile/package.json` | Beam has the bundle `<version>` |
| phone native | `versionName` in `build.gradle` | the git tag `mobile-v<versionName>` exists |
| relay | `relay/package.json` | the image is in GHCR |

- New job `ota`: build `web/src/mobile` for release, zip, encrypt and sign,
  upload with `minNativeVersion` = the native version it was built against
  and release notes = the version's section of `mobile/CHANGELOG.md`.
  Independent of the store jobs. When both run, the bundle still goes up:
  shells older than its `minNativeVersion` are told to wait, new shells
  carry it built in.
- `HELD` loses its `mobile` entry in this pull request. Its merge ships the
  native build with the updater to TestFlight and Play and the first OTA
  bundle.
- Secrets `OTA_PRIVATE_KEY` and `BEAM_UPLOAD_KEY`; the Beam app is created
  by the maintainer in Beam's admin. Steps in a new runbook
  `ship-the-phone-over-the-air`.

## The app

- `autoUpdate: 'onlyDownload'`; the app calls `notifyAppReady()` once it has
  started, and a bundle that does not is rolled back by the plugin.
- On `updateAvailable` (downloaded), the phone shows a quiet prompt with
  the version: **Restart** calls `set()` and the app reloads into it;
  closing it leaves the bundle for the next start (As built: not through
  `next()`).
  Shown once per version. Its look comes from Claude Design.
- A draft in the composer survives the reload.
- Stats carry the device model (from `@capacitor/device`); no
  `setCustomId`.
- Settings' footer shows `<app version> · shell <native version>`, the
  native one from `@capacitor/app` `getInfo()`.

## Privacy

The website's privacy policy gains what the phone sends Beam: a random
install id generated by the app, the device model, the OS and its version,
the app and shell versions, and whether an update installed. No name,
account, location, or anything about sessions or the Mac. The same goes
into Play's Data safety and Apple's privacy details, filled in by the
maintainer.

## The phone

This is a phone feature. The Mac, the server and the relay do not change;
the web app changes only under `web/src/mobile`.

## Testing

- `release-plan` with the four items, `check-versions` with the two phone
  versions.
- The signing script: round trip with the public key, refusal of a
  tampered bundle and of another key's signature.
- Beam's own tests for the new upload fields, the version endpoint and the
  model in stats.
- On a device: the patched Android plugin refuses a bundle without a
  session key; iOS refuses one with a bad signature; a bundle that never
  calls `notifyAppReady()` rolls back.

## As built (2026-10-09)

- **No Android patch.** 8.51.23 added the check upstream; 8.51.25 is pinned
  exactly and refuses a missing session key on both platforms
  ([[an-ota-bundle-runs-only-if-signed-by-ci]] has the lines).
- **The release build is named.** The root `android:release`,
  `android:bundle` and `ios:release` set `ORBITAL_MOBILE_RELEASE=1`; only
  that build configures the updater, and it fails without
  `mobile/ota-public-key.pem` (PKCS#1). Every other build sets
  `autoUpdate: false` and empty URLs: with no config at all the plugin
  would ask Capgo's cloud.
- **Beam in one place.** `mobile/beam.json` holds the URL and app id for
  the native config, the scripts and the web build; `scripts/beam.mjs`
  holds the HTTP contract.
- **Closing is not `next()`.** The plugin's `next()` switches the next time
  the app goes to the background, which reloads it under the user. × stores
  the bundle instead, and the next start switches to it before boot, behind
  the launch screen (`web/src/mobile/update/platform.ts`).
- **A fresh store install is not prompted for itself.** The built-in bundle
  reports itself to Beam as `builtin`, so Beam offers a new shell the
  bundle it already carries. A download of the version already running is
  taken quietly at the next start.
- **The prompt** is canvas `Feature - Phone update`: the UPDATE notice kind
  on the session list, READY then the AFTER × receipt, the restart frame;
  Settings' footer is `<app> · shell <native>` with the fingerprint on its
  own line. Drafts cross the reload through a one-time localStorage stash.
- **device_info** goes through native HTTP once per start, with the
  plugin's install id and its name for the running bundle.
- **The plugin reports more than update results.** With `statsUrl` set it
  also sends foreground and background events and the WebView's errors —
  message, stack, page URL — and crash and low-memory exits, with no switch
  to turn those off short of no stats at all. The privacy policy says so.
- **The `ota` job writes the Firebase configs** before the web build: the
  build turns push off for a shell without them (`__MOBILE_PUSH__`).

## Out of scope

- Channels and staged rollouts in Beam.
- Release notes shown in the phone's prompt.
- Forcing an update.
