---
id: 2026-10-08-builds-for-testers-design
title: A merged version bump builds and ships that app to testers
status: active
type: spec
domain: release
related:
  - 2026-10-08-release-roadmap
  - the-desktop-app-updates-itself
  - release-the-dmg-from-github-actions
  - a-version-ships-once-from-one-workflow
  - trim-and-sign-the-desktop-package
  - firebase-ios-leaves-cocoapods
  - android-releases-upload-through-gradle-play-publisher
  - a-shipped-version-never-goes-back
  - run-the-desktop-app
  - build-the-ios-app
  - build-the-android-app
tags:
  - release
  - ci
  - desktop
  - mobile
---
# A merged version bump builds and ships that app to testers

Phase 1 of [[2026-10-08-release-roadmap]].

## What changes for the user

A pull request that bumps an app's version is merged to `main`, and that
app reaches testers without anyone touching a Mac:

- **Mac** — a published GitHub Release with the DMG; an installed app
  downloads the update itself and offers a restart.
- **iOS** — a build in TestFlight's internal group.
- **Android** — a build on Play's Internal testing track.
- **Relay** — a new image in GHCR, tagged with its version and `latest`.

Only the app whose version went up is built. A merge without a bump
publishes nothing new anywhere: no build, no image, no moved tag.

## Decisions taken while designing

- The Mac release is **published at once**, not left as a draft. It is
  what TestFlight and Play Internal do too, and a draft is offered to no
  one ([[the-desktop-app-updates-itself]]). The guard against a broken
  build is CI before the merge; the fix is the next bump.
- Release notes go **only to the GitHub Release**, from the version's
  section of `desktop/CHANGELOG.md`. TestFlight and Play get none.
- Restarting into an update offers **"Restart now"** and **"Restart when
  sessions finish"**.
- The relay image is built **only on a relay version bump**, like the
  apps. Until now `relay-image.yml` rebuilt it on every change under
  `relay/` or `shared/` and moved its version tag and `latest` with it.
- **One workflow**, `release.yml`, decides and ships all four. Whether a
  version has shipped is read from where it ships to: the GitHub Release,
  the image in GHCR, and for the phone a git tag the workflow writes
  itself ([[a-version-ships-once-from-one-workflow]]). Nobody tags by hand.
- iOS signs with **automatic signing through the App Store Connect API
  key**, not an exported distribution certificate and profile.
- Only the desktop app makes **GitHub Releases**. The phone gets a tag.

## The release workflow

`.github/workflows/release.yml`, on `push` to `main` and on
`workflow_dispatch` (a retry after a failure outside our control, an
Apple outage say). `concurrency: release`, `cancel-in-progress: false`:
two releases never run over each other, and a queued one runs after.
It replaces `release-mac.yml` and `relay-image.yml`, which are deleted.

### `plan`

Runs `scripts/release-plan.mjs` and exposes its answer as job outputs:

| app | version from | shipped when |
|---|---|---|
| desktop | `desktop/package.json` | a GitHub Release `v<version>` exists (`gh release view`) |
| phone | `versionName` in `mobile/android/app/build.gradle` | the git tag `mobile-v<versionName>` exists (`git ls-remote --tags`) |
| relay | `relay/package.json` | the image `orbital-relay:<version>` exists in GHCR (`docker manifest inspect`) |

A version that has not shipped sets `mac=true`, `mobile=true` or
`relay=true`.

Where the version ships to, not the diff of the push, is the test. A run
that failed half way left nothing there, so the next push or a manual run
ships it again; a push that does not touch a version ships nothing.
`check-versions.mjs` already refuses a version that goes back
([[a-shipped-version-never-goes-back]]), so a version not out there is
always a new one. It also means a version that went out by hand — the relay
image built before this workflow, say — is seen as shipped, with no step
to tell the workflow about it.

The phone is the exception because its builds land in two stores that are
not cheap to ask; the tag is the workflow's own note that both took it.

The tag `v<version>` that `gh release create` writes is the form
`electron-updater` expects.

### `mac` (macOS runner, when `mac`)

The steps of today's `release-mac.yml`, changed where the update needs it:

- `desktop/electron-builder.yml` adds a `zip` target beside `dmg` and
  `publish: { provider: github }`. The publish setting is what writes
  `app-update.yml` into the app, from which `electron-updater` knows where
  to look. The build itself runs with `--publish never`; the workflow
  uploads.
- `dist:local` and `dist:self` pass `-c.publish=null`, so a local build
  carries no `app-update.yml` and never checks.
- After the `spctl` check, `gh release create v<version>` with the DMG,
  the ZIP, their blockmaps and `latest-mac.yml`, **published**, target
  the commit, title `Orbital <version>`. The notes are the
  `## [<version>]` section of `desktop/CHANGELOG.md`; when there is none,
  `--generate-notes`. `gh release create` writes the tag.
- `electron-builder` is pinned to an exact version, closing that item of
  [[trim-and-sign-the-desktop-package]].

### `ios` (macOS runner, when `mobile`)

`npm ci`, `GoogleService-Info.plist` written from its secret, then
`npm run ios:release` — the command run locally today.

`mobile/scripts/ios-release.sh` learns one thing: when `ASC_KEY_PATH`,
`ASC_KEY_ID` and `ASC_KEY_ISSUER` are set, it passes them to both
`xcodebuild` calls as `-authenticationKeyPath`, `-authenticationKeyID` and
`-authenticationKeyIssuerID`. With `-allowProvisioningUpdates`, which it
already passes, Xcode then fetches the certificate and the profile through
the key. Without them it signs through the Xcode account, as today.

The key is the one the Mac job notarizes with. Cloud-managed distribution
signing may need it at the **Admin** role; the first run tells. If it
passes at a narrower role, the runbook keeps the narrower one.

A clean runner is where a pod that stops resolving shows up first
([[firebase-ios-leaves-cocoapods]]). A failure here does not stop the Mac
or Android jobs.

### `android` (Ubuntu runner, JDK 21, when `mobile`)

The secrets are written to the paths `build.gradle` already reads —
`secrets/orbital-upload.jks`, `secrets/keystore.properties`,
`secrets/play-service-account.json` and
`mobile/android/app/google-services.json` — then
`npm run android:release` builds and uploads to Internal testing.

### `tag-mobile` (when `mobile`)

Needs `ios` and `android`. When both succeeded, pushes the tag
`mobile-v<versionName>`. If one failed, no tag: the retry builds both
again. Apple and Play both refuse a build number they have seen, so the
platform that had already uploaded fails its retry; the retry is then run
with only the failed job (`Re-run failed jobs`), not by a new push.

### `relay` (Ubuntu runner, when `relay`)

The two jobs of today's `relay-image.yml`, moved: typecheck and test the
relay on Linux, then build `relay/Dockerfile` and push it to
`ghcr.io/<owner>/orbital-relay` tagged `<version>`, `latest` and the
commit's sha. Because it runs only for a version not yet in GHCR, the
version tag never moves once written, and `latest`
moves only to a new version. Nothing is deployed from here, as before; the
runbook `run-the-relay` covers pulling the image.

`ci.yml` keeps building the image without pushing it, so a broken
Dockerfile still fails the pull request.

### Secrets on the runner

Every job writes its secret files under `$RUNNER_TEMP` or the git-ignored
paths above and removes them in an `if: always()` step.

| secret | job | holds |
|---|---|---|
| `MAC_CERT_P12_BASE64` | mac | Developer ID Application certificate, `.p12`, base64 |
| `MAC_CERT_PASSWORD` | mac | its export password |
| `APPLE_API_KEY_P8` | mac, ios | App Store Connect API key file contents |
| `APPLE_API_KEY_ID` | mac, ios | the key's ID |
| `APPLE_API_ISSUER` | mac, ios | the issuer ID |
| `IOS_GOOGLE_SERVICE_INFO_PLIST` | ios | `GoogleService-Info.plist` |
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | android | `orbital-upload.jks`, base64 |
| `ANDROID_KEYSTORE_PROPERTIES` | android | `keystore.properties` |
| `PLAY_SERVICE_ACCOUNT_JSON` | android | the service account's JSON key |
| `ANDROID_GOOGLE_SERVICES_JSON` | android | `google-services.json` |

The App Store Connect app, the Play Console app with its first bundle, the
service account and the upload key all exist already; only the secrets are
new. The steps for setting each go into the runbooks `run-the-desktop-app`,
`build-the-ios-app` and `build-the-android-app`.

## The desktop app updates itself

As decided in [[the-desktop-app-updates-itself]]; this is how.

### In the main process

- `electron-updater` checks on launch and then every
  `UPDATE_CHECK_INTERVAL_MS` (a few hours), downloads a newer version in
  the background, and installs it on the next quit
  (`autoInstallOnAppQuit`).
- It does not run in a dev build, and not when `app-update.yml` is absent
  from the resources (`dist:local`, `dist:self`).
- A failed check or download is logged and tried again at the next
  interval. It is never shown: a tester without an update loses nothing.
- When the download is complete, main sends `update-ready` with the
  version through the preload; the web app asks for the current state on
  load, so a reload does not lose it.

### Restarting into it

The prompt (below) offers:

- **Restart now** — `quitAndInstall` at once. Orbital sessions that are
  working end mid-turn and are marked `interrupted`, as on any restart; when
  some are working, the button says how many.
- **Restart when sessions finish** — main remembers the wish and calls
  `quitAndInstall` the first moment no Orbital session is working. It
  reads that from `sessionsFeed`, which it already keeps for
  notifications. Terminal sessions do not count: restarting the app does
  not touch them.

When nothing is working, the prompt shows a single **Restart**. Closing
the prompt leaves the update to install on quit; it does not come back for
the same version.

The decisions — whether to check, whether a restart may happen now, the
waiting state and what cancels it — are pure functions in
`desktop/src/lib/updates.ts`, tested with vitest like the rest of
`desktop/src/lib`.

### The prompt's look

Not designed here. Its look and place come from Claude Design, from this
prompt, and the build is checked against the canvas:

> Orbital's desktop app has downloaded a new version and can restart into
> it. Design a quiet prompt for that, following `docs/why-orbital.md`: no
> badge, no colour that reads as a state, no sound, nothing that moves
> after it appears, nothing that covers a session the user is working in.
> It appears once per version and stays until acted on or closed. It
> carries the new version, and either one action **Restart** (no Orbital
> session working) or two, **Restart now** and **Restart when sessions
> finish**, with the number of working sessions that "now" would
> interrupt. Once "when sessions finish" is chosen it shows that it is
> waiting and lets the wait be cancelled. Closing it says the update
> installs when Orbital quits. Look at the existing notice toast
> (`Feature - Notifications off.dc.html`) and say whether this is a kind
> of it or something else.

## The phone

This phase is how the phone app reaches testers, so it is built for the
phone by definition: the `ios` and `android` jobs.

The update prompt is desktop only, on purpose: the phone updates through
TestFlight and Play, which do their own prompting. Whether a newer Mac and
an older phone still talk is
[[2026-10-07-version-compatibility-design]]'s business. Shipping the web
bundle to the phone without a store build is a separate idea
(`ota-updates-through-beam`), not part of this phase.

## Testing

- `scripts/release-plan.mjs`: reading the three versions, the names it
  asks about, and the answer when each is present or missing. The lookups
  themselves (`gh`, `git`, `docker`) are passed in, so the tests do not
  reach the network.
- `desktop/src/lib/updates.ts`: the restart states — now, waiting, a
  session starting while waiting, cancelling, nothing working.
- The workflow itself is proven by its first real run; nothing replaces
  that.

## The first run

Nothing is prepared by hand. The pull request that lands this phase bumps
the desktop app to 0.25.0, so the first GitHub Release already carries the
updater; 0.24.0, which has none, is never released on its own. As of
2026-10-09 the first run then ships desktop 0.25.0 and phone 0.7.0 (never
uploaded, no tag), and skips relay 0.4.0, whose image is already in GHCR.
The phone thereby tests both store uploads at once.

Whoever runs an older desktop build installs the 0.25.0 DMG once by hand;
from then on the app updates itself.

## Out of scope

- Release notes in TestFlight and Play.
- A Homebrew cask ([[trim-and-sign-the-desktop-package]]).
- Over-the-air web updates for the phone.
- Production releases on either store; they stay made by hand.
