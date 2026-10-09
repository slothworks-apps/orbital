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
- Commit `mobile/ota-public-key.pem` in a pull request before the one that
  first ships the shell with the updater, or that release's store jobs fail.

**A new key** is a new shell: each installed shell trusts only the key it
was built with. Commit the new public key with a native version bump, set
the new secret when that store build is out, and expect the phones still on
the old shell to take no bundles until they update from the store.

## Once: the app on Beam

1. Beam's admin → Apps → new app with the id `io.slothworks.orbital.mobile`
   (`mobile/beam.json`).
2. Copy its upload key: `gh secret set BEAM_UPLOAD_KEY`.

The `plan` job reads the same key to ask Beam whether a version is there;
without it, or with Beam down, the whole release run fails rather than
guessing, desktop and relay included.

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
```

Without the Firebase configs in the native projects the web build turns
push off; the CI job writes them first for that reason.

## Rollback

- **A bundle that does not start** rolls back on the phone by itself: one
  that never reaches its first screen does not call `notifyAppReady()`, and
  the plugin goes back to the previous bundle about ten seconds later.
- **A bundle that starts but is wrong:** Beam's admin → the app → Bundles →
  promote the previous one. Phones are offered it as an update (the prompt
  names the older version). Then fix forward with a higher version: a
  version is never reused, and Beam refuses one it already has (409).

## Check it on a device

Debug output: `adb logcat | grep -i capgo` on Android, the Xcode console on
iOS. Beam's admin shows each install with its model, OS and versions.

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
6. **A bundle that never starts rolls back:** a bundle whose `main.tsx`
   throws before rendering. Restart into it: the app comes back on the
   previous version and Beam records the failed update.

Steps 4–6 reach every tester's phone while they are in Beam, to be refused
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
