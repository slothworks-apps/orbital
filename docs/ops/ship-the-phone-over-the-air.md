---
id: ship-the-phone-over-the-air
title: Ship the phone app over the air
type: runbook
status: in-force
domain: mobile
related:
  - 2026-10-09-phone-ota-updates-design
  - an-ota-bundle-runs-only-if-signed-by-ci
  - the-phone-has-an-app-version-and-a-native-version
  - build-the-android-app
  - build-the-ios-app
tags:
  - mobile
  - release
  - security
---
# Ship the phone app over the air

The phone app's code (`web/src/mobile`) ships as a signed bundle through
Beam, Slothworks' own update server at `https://beam.slothworks.io`; only a
change to the native shell needs TestFlight and Play
([[2026-10-09-phone-ota-updates-design]]). The plugin is
`@capgo/capacitor-updater`, talking to Beam only.

| what | version | ships when |
|---|---|---|
| the app (bundle) | `version` in `mobile/package.json` | Beam has no bundle of that version |
| the shell (native) | `versionName` / `versionCode` in `build.gradle` | no tag `mobile-v<versionName>` |

Both go out from `.github/workflows/release.yml` on a merge to `main`
([[the-phone-has-an-app-version-and-a-native-version]]).

## Once: the key pair

Every bundle is signed with an RSA key whose private half lives only in
GitHub's secrets ([[an-ota-bundle-runs-only-if-signed-by-ci]]). The public
half is committed and built into the shell; a release build without it
stops at `cap sync` with "mobile/ota-public-key.pem is missing".

```bash
openssl genrsa -out ota-private.pem 2048
openssl rsa -in ota-private.pem -RSAPublicKey_out -out mobile/ota-public-key.pem
head -1 mobile/ota-public-key.pem          # -----BEGIN RSA PUBLIC KEY-----
gh secret set OTA_PRIVATE_KEY < ota-private.pem
```

- The public key must be PKCS#1 (`BEGIN RSA PUBLIC KEY`, which
  `-RSAPublicKey_out` writes). With `BEGIN PUBLIC KEY` the plugin skips
  decryption, and `capacitor.config.ts` refuses it.
- 2048 bits exactly: the plugin takes a signed checksum of 256 bytes only.
- Run the commands outside the repository, or delete `ota-private.pem`
  afterwards (`.gitignore` ignores `*private*.pem`, gitleaks would refuse it
  anyway). Keep one copy offline, in the password manager: without it no
  installed shell takes another update.
- **The maintainer commits `mobile/ota-public-key.pem` before the pull
  request that adds the updater is merged.** Without it the release build
  stops at `cap sync` and the store jobs fail, and the `ota` job fails
  checking the signed bundle against it.

**A new key** is a new shell: each installed shell trusts only the key it
was built with. Commit the new public key with a native version bump, set
the new secret when that store build is out, and expect the phones still on
the old shell to take no bundles until they update from the store.

## Once: the app on Beam

1. Beam's admin → Apps → new app with the id `io.slothworks.orbital.mobile`
   (`mobile/beam.json`).
2. Copy its upload key: `gh secret set BEAM_UPLOAD_KEY`.

The `plan` job reads the same key to ask Beam whether a version is there.
Without it, or with Beam down, the phone app is planned as `error` and the
`ota` job fails visibly; the desktop app, the relay and the store builds
still ship. It is never read as "not shipped".

**A stolen upload key** cannot ship code (bundles must be signed), but it can
upload a bundle under a version before CI does — Beam then refuses CI's
upload with 409 and `release-plan` sees the version as shipped — or promote
an older signed bundle (refused by the phone's replay guard). Beam's version
lookup returns only the version and its date, so CI cannot check that what
Beam holds opens with our key. If the key may have leaked: rotate it in
Beam's admin, update `BEAM_UPLOAD_KEY`, delete any bundle CI did not upload,
and ship the next version.

## Every release

1. Bump `version` in `mobile/package.json` (patch for a fix, minor for a
   feature) and `npm install --package-lock-only` for the lockfile's copy.
   A change that needs the shell — a native plugin, a permission, an
   `Info.plist` or manifest change, a Capacitor upgrade — bumps
   `versionName` and `versionCode` too (`mobile/CLAUDE.md`).
2. A line under `## [Unreleased]` in `mobile/CHANGELOG.md`, renamed to the
   version in the bump.
3. `node scripts/check-versions.mjs`.
4. Merge. `release-plan` sees Beam has no bundle of that version and the
   `ota` job runs: builds the bundle as the store jobs do, signs it, checks
   it opens with `mobile/ota-public-key.pem`, and uploads it with
   `minNativeVersion` = `versionName` and the version's changelog section
   as its notes.

Beam serves an uploaded bundle to every phone at once. A phone checks when
it opens, downloads in the background, and offers the version above the
session list; Restart takes it at once, × at the next start. A shell older
than the bundle's `minNativeVersion` is told to wait for the store.

### Without CI

The signing needs the private key, so only the maintainer can run it:

```bash
npm run build:mobile -w @orbital/web
OTA_PRIVATE_KEY_FILE=~/path/ota-private.pem node scripts/ota-bundle.mjs --out /tmp/bundle.enc   # check only
OTA_PRIVATE_KEY_FILE=~/path/ota-private.pem BEAM_UPLOAD_KEY=… node scripts/ota-bundle.mjs       # upload

CI passes the key in `OTA_PRIVATE_KEY` to the signing step alone; it is never
written to disk and does not exist while `npm ci` or the build runs.
```

Without the Firebase configs in the native projects the web build turns
push off; the CI job writes them first for that reason.

## Rollback

- **A bundle that does not start** rolls back on the phone by itself: one
  that never reaches its first screen does not call `notifyAppReady()`, and
  the plugin goes back to the previous bundle about ten seconds later.
- **A bundle that starts but is wrong:** fix forward with a higher version
  — revert the change and ship it as the next patch. Promoting an older
  bundle in Beam does nothing: phones take only a version above the one they
  run, and a bundle below the highest one a phone has run refuses to start
  ([[an-ota-bundle-runs-only-if-signed-by-ci]] → Residual risk). A version is
  never reused, and Beam refuses one it already has (409).
- **A security fix** also raises `MIN_APP_VERSION` in
  `web/src/mobile/update/guard.ts` to the fixed version, so no older bundle
  starts again on any phone that runs it.

## Check it on a device

Debug output: `adb logcat | grep -i capgo` on Android, the Xcode console on
iOS. Beam's admin shows each install with its model, OS and versions — the
model and the install results only while the phone's Settings → Send
diagnostics is on, which it is by default.

1. Install the store build. Settings' footer reads `<app> · shell <native>`.
   The install appears in Beam with its model.
2. Ship an app-only bump. Open the app: the UPDATE notice shows above the
   session list. Restart: the restart frame, then the list again, with a
   draft typed before still in its composer, and the new version in the
   footer.
3. Ship another and close the notice with ×: the receipt, OK, and the new
   version only after the app is closed and opened again.
4. **Android refuses a bundle without a session key:** upload one to Beam
   without `sessionKey` and `checksum` (curl, with the upload key). The
   download fails with "Session key required when public key is present"
   and Beam records `session_key_required`. Delete the bundle in Beam.
5. **A bad signature is refused (iOS and Android):** make a throwaway key
   pair, put its public key in `mobile/ota-public-key.pem` locally (not
   committed), run `ota-bundle.mjs` with its private key and an unused
   version, upload. The phone refuses it at the checksum. Delete it in Beam
   and restore the real public key.
6. **Diagnostics off:** Settings → Send diagnostics off. Close and reopen the
   app: Beam still sees the update checks, but no new stats events and no
   `device_info` for the install. On again: they come back.
7. **An older signed bundle is refused:** take the encrypted zip, session
   key and checksum of a version the phone has already passed and upload them
   under a higher, unused version. Restart into it: the launch screen stays,
   the app goes back to the newer bundle, and the log says "refused bundle".
8. **A bundle that never starts rolls back:** a bundle whose `main.tsx`
   throws before rendering. Restart into it: the app comes back on the
   previous version and Beam records the failed update.

Steps 4, 5, 7 and 8 reach every tester's phone while they are in Beam, to be refused
or rolled back; do them when nobody relies on the app.

## Dev builds

Every build but the release scripts' turns the updater off
(`mobile/capacitor.config.ts`), so `npm run build -w @orbital/mobile` and
dev builds never talk to Beam. To look at the UPDATE notice and the restart
frame in a browser, pair the browser as [[build-the-android-app]] → "In a
desktop browser" says (the notice shows on the session list only), open the
page with `?update-demo`, then in the console
`__orbitalUpdateDemo('ready' | 'closed' | 'restart' | 'none', { version, shell })`.
A built bundle has it only with `VITE_ORBITAL_UPDATE_DEMO=1`.
