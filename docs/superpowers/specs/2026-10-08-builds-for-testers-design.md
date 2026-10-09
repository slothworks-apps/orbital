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
  offers the update, downloads it when asked (or by itself, if the user
  turned that on) and offers a restart.
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
- Downloading an update is **asked first by default**; a setting turns on
  automatic download. Restarting into an update offers **"Restart now"** and **"Restart when
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
| desktop | `desktop/package.json` | a GitHub Release `v<version>` is published (`gh release view`) |
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
  sets `publish: null`. Only the `dist` script — the release build — turns
  the publisher on, with `-c.publish.provider=github
  -c.publish.owner=slothworks-apps -c.publish.repo=orbital`. The publish
  setting is what writes `app-update.yml` into the app, from which
  `electron-updater` knows where to look. The build itself runs with
  `--publish never`; the workflow uploads.
- `dist:local` and `dist:self` inherit `publish: null`, so a local build
  carries no `app-update.yml` and never checks. The default is off rather
  than the local scripts switching it off because `-c.publish=null` on the
  command line reaches electron-builder as the string `"null"`, which it
  takes for the name of a publisher and fails on.
- After the `spctl` check, `gh release create v<version>` with the DMG,
  the ZIP, their blockmaps and `latest-mac.yml`, **published**, target
  the commit, title `Orbital <version>`. The notes are the
  `## [<version>]` section of `desktop/CHANGELOG.md`; when there is none,
  `--generate-notes`. The release is created as a draft with its files and
  published as soon as they are all up, so an upload that fails half way
  never leaves a published release without its update feed; `plan` counts
  a draft as not shipped, and the next run replaces it. Publishing writes
  the tag.
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

As decided in [[the-desktop-app-updates-itself]]; this is how. The prompt's
states, words and look come from Claude Design, `Feature - App
update.dc.html`.

### In the main process

- `electron-updater` checks on launch and then every
  `UPDATE_CHECK_INTERVAL_MS` (a few hours), and installs what it has
  downloaded on the next quit (`autoInstallOnAppQuit`).
- It does not run in a dev build, and not when `app-update.yml` is absent
  from the resources (`dist:local`, `dist:self`).
- A failed check is logged and tried again at the next interval. It is
  never shown: a tester without an update loses nothing.
- Every decision — whether to download, what the prompt shows, when a
  restart may happen — is the pure state machine `UpdateFlow` in
  `desktop/src/lib/updates.ts`, tested with vitest like the rest of
  `desktop/src/lib`. `main.ts` feeds it what each check found (from the
  check's own result, so a launch or interval check running at the same
  moment as Check now cannot take its version), electron-updater's events
  (`download-progress`, `update-downloaded`, `error`), a rejected
  `downloadUpdate()`, and the working count; and it does what each step
  says: push the state, start a download, write the skipped version, look
  again once a zero count has settled, call `quitAndInstall`.
- On every change main pushes `update-state` through the preload
  (`onUpdateState`); the web app asks for it on load with
  `get-update-state` (`getUpdateState`), so a reload keeps the prompt. The
  state is the phase — `none`, `available`, `downloading`, `ready`,
  `waiting`, `closed` or `restarting` — with what that phase needs (the
  version, the size in whole MB and the percent, the working count, Ready's
  buttons), and `checkedAt`, when a check last completed. The prompt's
  buttons go back as `update-action` (`updateAction`): `download`, `skip`,
  `restart-now`, `restart-when-idle`, `cancel-wait`, `close`, `ok`. Only
  Orbital's own windows are heard or answered.

### Download: asked first, or automatic

A setting, **Download updates automatically** (`update_auto_download`),
off by default. It lives with the other settings (`/api/settings`); main
reads it before every check and again on `settings-changed`. The phone
never sees it: the remote allowlist denies `/api/settings`.

electron-updater's own `autoDownload` stays off in both modes: the flow
says when to download, because only the flow knows which version was
skipped, and a skipped version must not download even with the setting on.

- **Off** (default): a check that finds a newer version moves the flow to
  `available`. **Download** starts `downloadUpdate()` and the phase becomes
  `downloading`, with the percent and the size; it goes on into `ready` in
  the same prompt. A failed download goes back to `available`. Turning the
  setting on while Available is shown downloads that version, as Download
  would.
- **On**: a found version downloads at once and silently — `available` and
  `downloading` are never shown — and the prompt starts at `ready`. A
  failed download stays silent and the next check tries again.
- `update-downloaded` comes before Squirrel.Mac has staged the zip, and it
  can still refuse it; `downloadUpdate()` then rejects. From `ready`,
  `waiting`, `closed` or `restarting` the version goes back to `available`
  and no longer counts as downloaded. An updater `error` while
  `restarting` — `quitAndInstall` did not get the app out — does the same,
  so the prompt never stays restarting; any other `error` is a failed check
  and changes nothing.
- **× on Available skips that version.** It is never offered again, not
  even after a restart, unless the user asks with Check now; a newer
  version is offered as usual. The skipped version is kept in
  `<userData>/update-skip.json`, not in the server's settings: it belongs
  to this app's installer, main is its only reader and writer, and it has
  to be known at the first check whether the server answers yet or not.
- A newer version found while a downloaded one is `ready` or `waiting` is
  held: the restart installs the one downloaded, and the next check offers
  the newer one. A newer *download* (setting on) replaces a waiting or
  closed prompt with one for the newer version.

### Check now

Settings › Updates' **Check now** and the menu bar's **Orbital → Check for
Updates…** run the same check through `check-for-updates`
(`checkForUpdates`), which answers `up-to-date`, `error`, `unsupported` in
a build that does not update itself, or `found` with the version and what
the flow did with it: `offered` on the map, `downloading` by itself,
`installs-on-quit` (already downloaded and its prompt ended with OK),
`held` behind a downloaded version waiting for its restart. A check
started this way offers a skipped version again and forgets the skip.
Settings words its result line from that answer; the menu item shows a
quiet message box, except when the prompt on the map is the answer
(`offered`).

### Restarting into it

**Ready** fixes its buttons when it appears:

- no Orbital session working then — one **Restart**, which restarts at
  once, or waits like the next one if a session started meanwhile;
- one or more working — **Restart now** and **Restart when sessions
  finish**, with the number "now" would interrupt. The number updates in
  place; the buttons stay as they were.

**Restart now** calls `quitAndInstall` at once; Orbital sessions that are
working end mid-turn and are marked `interrupted`, as on any restart.
**Restart when sessions finish** moves to `waiting`: main calls
`quitAndInstall` the first moment no Orbital session is working, a
session started meanwhile waited for too. **Cancel** goes back to the
two-button choice.

The count is `WorkingSessions.count`, folded from `sessionsFeed`, which
main already keeps for notifications — the same count the quit guard reads:
Orbital sessions that are `working`. Terminal sessions do not count:
restarting the app does not touch them. **A session waiting on a decision
— a permission prompt, a question, a plan — does not hold the restart**: it
reads `needs_input`, is interrupted like any session, and is continued
after the update. A turn's end reads `needs_input` until the CLI says it is
running again, so a turn the CLI starts by itself right after (a message
queued while it worked, a background agent reporting back) can read
working, not working, working within milliseconds; a wait restarts only
once the zero has held for `IDLE_SETTLE_MS`. The server replays nothing to
a new subscriber, so after every connect and reconnect main reads
`GET /api/sessions?source=web` once to learn which sessions were already
mid-turn; until that read has landed the count is unknown, an unknown count
never ends the wait, and Ready shows two buttons.

**× on Ready** shows the receipt (`closed`): the update installs when
Orbital quits, with **OK**, which ends the prompt for that version.

### The prompt

It is the notice toast's UPDATE kind (canvas `Feature - Notice toast`),
the first in its queue order: same shell, same slot at the top centre of
the map, neutral ink only, fades in and nothing moves after but the
download line. It replaces the toast's earlier, never-built UPDATE
message ("A new version is out", Get it on GitHub). One message carries
the whole update; its states swap their words in place, and only the last
one — skip, or OK on the receipt — ends it. While it is downloading or
waiting it keeps the slot, and the messages behind it wait with their
dots. Downloading and Waiting have no ×. There is no badge anywhere. It
exists only in the desktop app's main window, where the preload exposes
the update calls.

### Settings › Updates

A tab of its own, last after Shortcuts, desktop only:

- **VERSION** — the installed version with **Check now**, the result line
  (when it last checked, "Checking…", or what it found), and the release
  notes of the installed version on GitHub.
- **DOWNLOADS** — **Download updates automatically**, off by default.

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
- `desktop/src/lib/updates.ts`: every state and action of `UpdateFlow` —
  asked first and automatic, the skip and Check now, a failed download,
  Ready's fixed buttons, waiting (a session starting, cancelling, an
  unknown count after a reconnect), the receipt, a newer version arriving;
  the parsers for what crosses IPC and the skip file.
- `desktop/src/lib/appMenu.ts`: Check for Updates… under About, Quit kept.
- `web/src/lib/appUpdate.ts`: the prompt's words in each state and
  Settings' result line. React rendering is not tested; the look is
  checked against the canvas. `?update-demo`, in a dev server or a build
  made with `VITE_ORBITAL_UPDATE_DEMO=1`, drives the prompt and the tab in
  a browser without Electron (`web/src/lib/updateDemo.ts`).
- The server seeds `update_auto_download` off.
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
