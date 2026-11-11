---
id: release-to-the-app-store
title: Release the iOS app on the App Store
type: runbook
status: in-force
domain: mobile
related:
  - build-the-ios-app
  - ship-the-phone-over-the-air
  - store-review-without-a-mac
  - run-the-relay
tags:
  - mobile
  - ios
  - release
---
# Release the iOS app on the App Store

The iOS app already reaches testers through TestFlight
([[build-the-ios-app]] → Release to TestFlight). This runbook takes a build
that is in TestFlight to the public App Store: the one-time setup of the
listing, the submission, and what later releases need.

The texts for every field (name, subtitle, description, keywords, URLs, age
rating, App Privacy answers, review notes, the review video's shot list) are
in `mobile/store/app-store.md`. Paste from there; change them there first.

SlothWorks runs no relay for App Store users: each user runs their own from
the Docker image ([[run-the-relay]]). Such a relay cannot send push to the
store app, which is built with SlothWorks' Firebase project, so the listing
promises notifications only while the app is open
(`mobile/store/app-store.md` → Push notifications with your own relay).

Google Play gets a sibling runbook of its own; the shared texts and the
privacy reasoning in `mobile/store/app-store.md` are written to serve both.

## Before the first submission

These come from `mobile/store/app-store.md` → Open points. The first two
block the submission:

- **A privacy policy link inside the app** (guideline 5.1.1(i)) and a line
  on the first screen saying where to get Orbital for Mac, both in the build
  that is submitted. The build is the binary's own bundle; an over-the-air
  bundle does not count, since review sees the app as installed.
- **A support URL with a contact address** (guideline 1.5).
- **The review video**, recorded on a real iPhone ([Review video](#review-video)).
- **Screenshots** ([Screenshots](#screenshots)).
- **The website and the privacy policy** say what holds for App Store users:
  no SlothWorks relay, no push through a self-hosted relay
  (`mobile/store/app-store.md` → Open points, Proposed privacy policy
  changes).
- **Business → Agreements**: the Free Apps agreement is in force (it is by
  default); no paid agreement, tax or banking is needed for a free app.
- **EU trader status** (Digital Services Act): App Store Connect → Business
  (or the account's DSA section) → declare SlothWorks s.r.o. a trader. Its
  address, phone and e-mail are then shown on the EU product page; verify
  them. Without it the app is not offered in the EU.

## One-time steps in App Store Connect

All under Apps → Orbital by SlothWorks. The app record exists already
(created for TestFlight).

### 1. App Information

- **Name**, **Subtitle**: from the listing.
- **Category**: Primary Developer Tools, Secondary Productivity.
- **Content Rights**: "No, it does not contain, show, or access third-party
  content". The app shows only what the user's own sessions produce.
- **Age Rating** → Edit: answer the questionnaire as the listing's table says.
  Apple adds questions over time (Shared Location from 16 November 2026);
  answer new ones from the same reasoning and add them to the table.
- **License Agreement**: Apple's standard EULA.
- Save.

### 2. Pricing and Availability

- **Price**: Free (USD 0.00 tier).
- **Availability**: all countries or regions (France: see the encryption
  point in the listing's Open points first).
- **App Distribution Methods**: Public.
- **iPad and Mac availability**: the app is iPhone-only
  (`TARGETED_DEVICE_FAMILY = 1`). Leave "Make this app available on Mac
  (Apple silicon)" off: the Mac has Orbital itself.

### 3. App Privacy

- **Privacy Policy URL**: from the listing.
- **Data Collection** → Get Started: "Yes, we collect data", then tick the
  data types the listing's App Privacy conclusion names and nothing else.
- For each ticked type: purpose App Functionality only; "Is this data linked
  to the user's identity?" as the listing says; "Do you or your third-party
  partners use this data for tracking?" No.
- **Publish**. The label is shown on the product page from the next release
  on; it can be edited later without a new build, but only published answers
  count.

### 4. The version page (iOS App → 1.0 Prepare for Submission)

- **Version**: change `1.0` to the build's version, `versionName` in
  `mobile/android/app/build.gradle` (the build's `CFBundleShortVersionString`,
  [[build-the-ios-app]] → Every release). Versions stay below 1.0 until the
  app has been tested widely.
- **Previews and Screenshots**: the 6.9-inch iPhone set
  ([Screenshots](#screenshots)). App Store Connect scales it down for the
  smaller iPhones. No iPad set: the app is iPhone-only.
- **Promotional Text**, **Description**, **Keywords**, **Support URL**,
  **Marketing URL**: from the listing.
- **Build** → Add Build: pick the TestFlight build to release. It must carry
  the privacy policy link. A build whose export compliance is not answered
  cannot be picked; `ITSAppUsesNonExemptEncryption` answers it
  ([[build-the-ios-app]]).
- **General App Information**: the copyright line; the routing app coverage
  file is not needed.
- **App Review Information**: untick **Sign-in required**; contact name,
  phone and e-mail; **Notes** from the listing with the video link filled in;
  attach the video here instead if it is not linked.
- **App Store Version Release**: **Manually release this version** for the
  first release, so the website, the store link in the app and the
  announcement go out together. Later releases can use "Automatically
  release" or a date.
- **Phased Release**: off for the first release (there are no users to
  phase); consider it for later native releases. It throttles only automatic
  App Store updates; the over-the-air bundles are not phased by it.

### 5. Submit for Review

- Save, then **Add for Review** → **Submit to App Review**.
- Review usually answers within one to two days. The status moves Waiting
  for Review → In Review → Pending Developer Release (manual release) or
  Ready for Distribution.
- **Rejected**: the reasons come in App Review → the submission's messages
  (the Resolution Center). Answer there. A rejection for 2.1 because the
  app cannot be paired is answered with the video and notes again
  ([[store-review-without-a-mac]]); a rejection that needs a change in the
  app needs a new build: bump `versionCode`, release to TestFlight, swap the
  build on the version page and resubmit.

### 6. After approval

1. **Release This Version** (manual release). The app appears in the store
   within a few hours, in search after up to a day.
2. Note the app's Apple ID (App Information → General Information) and its
   store URL, `https://apps.apple.com/app/id<Apple ID>`.
3. **The website**: in `site/src/site.ts` set `APP_STORE_URL` to the store
   URL, and `PHONE_RELEASE` to `public` once Google Play is public too (it
   switches both phone cards at once). The site deploys from `main`.
4. **The app**: `web/src/mobile/platform/store.ts` → `storeUrl()` returns
   no link on iOS because the App Store id did not exist. With the id known,
   the update screen can open the App Store listing; a phone change of its
   own.
5. **TestFlight stays.** Internal testers keep getting builds there before
   they reach the store.

## Later releases

### What ships how

| change | how it reaches App Store users | new review? |
|---|---|---|
| The app's code (`web/src/mobile`, `shared/`): a bumped app version | An over-the-air bundle through Beam ([[ship-the-phone-over-the-air]]); the store version's shell downloads and offers it | No |
| The native shell: a bumped `versionName` and `versionCode` | `npm run ios:release` or the `ios` job uploads to TestFlight as today; then a new version page with that build is submitted | Yes |
| Listing texts: promotional text | Edit any time, live at once | No |
| Listing texts: description, keywords, screenshots, What's New | Only with a new version page | Yes, with it |
| App Privacy answers | Edit and publish any time | No, but they must be true of the version on sale |

A build uploaded to TestFlight is the same binary the App Store would sell:
there is no separate store build. Releasing a native version is opening a
new version page (the "+" next to iOS App), entering the build's
`versionName` as its version, picking the build, writing **What's New**
(from the `mobile/CHANGELOG.md` lines since the last store version, in the
user's words) and submitting it as in steps 4–5.

### When a new store submission is needed

- Every native change: a native plugin, a permission or usage string, an
  `Info.plist` or entitlement change, a Capacitor upgrade, a change to
  `capacitor.config.ts` (`mobile/CLAUDE.md` → Versions).
- An over-the-air bundle must not change what the app is for: Apple allows
  downloaded interpreted code only if it does not change the app's primary
  purpose (guideline 2.5.2, Developer Program License Agreement 3.3.1(B)).
  New features inside "follow and drive your sessions from the phone" are
  fine over the air. A feature that would make the app something else, or
  that asks for a permission, goes through a store submission.
- When the description or screenshots no longer match the app: refresh them
  with the next native release. A version page needs a build of its own
  version, so changing them alone also needs a native version bump and a
  new build.

### Screenshots

Made from staged demo data, never from real sessions: a throwaway Orbital
server runs against its own `ORBITAL_CLAUDE_DIR` and `ORBITAL_DATA_DIR`,
and the phone UI is rendered in WebKit at the iPhone 17 Pro Max's size
(440 × 956 points at 3×, the 6.9-inch 1320 × 2868 set). Not the simulator:
an Xcode without its Simulator app runs simulators headless, with no way to
tap; and the phone UI is the same web code in either.

1. **The stack**, each in the background, from the repository root:

   ```bash
   node mobile/scripts/store-demo.mjs /tmp/orbital-store-demo   # demo transcripts; rerun right before shooting
   RELAY_PORT=4840 RELAY_DATA_DIR=/tmp/orbital-store-relay npm run dev -w relay
   env -u ORBITAL_MIGRATIONS_DIR -u ORBITAL_STATIC_DIR -u ORBITAL_RESOLVE_PATH ORBITAL_PORT=4858 \
     ORBITAL_CLAUDE_DIR=/tmp/orbital-store-demo/claude ORBITAL_DATA_DIR=/tmp/orbital-store-demo/data npm run dev -w server
   ORBITAL_MOBILE_DEV=1 npm run dev:mobile -w @orbital/web       # the phone UI on :4841
   npx playwright install webkit                                 # once
   node mobile/scripts/store-driver.mjs                          # WebKit, driven over HTTP on :4880
   ```

   Turn the relay on for the server (`PATCH /api/settings` with
   `remote_enabled`, `remote_relay_url` `http://127.0.0.1:4840` and
   `remote_mac_name` `MacBook Pro`, as in [[build-the-android-app]] → Pair
   with a relay on this Mac).
2. **Pair** the driver's page: `POST /api/remote/pair`, fill its `qr` into
   `#pairing-code`, read the six characters the page then shows, and post
   them with `pendingPair.phone` to `/api/remote/pair/confirm`
   (`{"accept":true,"phone":…,"code":…}`). The driver's profile keeps the
   pairing for later runs.
3. **Live sessions.** Transcripts give the list, conversations, diffs and
   images, but a session staged from a transcript shows as a read-only
   terminal session. The cards that answer a question or approve a command,
   and moons, exist only for sessions the server started itself. Log the
   demo directory in once
   (`CLAUDE_CONFIG_DIR=/tmp/orbital-store-demo/claude claude auth login`),
   stop the transcript holders (`store-demo.mjs … --stop`), put the demo
   projects under `/Users/Shared/Projects/` (a path that reads like a Mac's;
   `/tmp` shows as `/private/tmp`) and start three short sessions with
   `POST /api/sessions`: one asked to put a choice to you as options, one
   asked to run `npm run deploy` in mode `default` (a permission card), one
   asked to run two background subagents (moons; they finish within a
   minute, so shoot while they run).
4. **Shoot.** Before each screenshot, evaluate `mobile/scripts/store-iphone.js`
   in the page: it puts the iPhone's safe areas in place of `env()`, which a
   desktop WebKit leaves at 0, and draws a 9:41 status bar. Then
   `page.screenshot`. Dismiss the notifications tip first; turn the worktree
   off on New session (the demo repositories have no `origin`).
5. **Convert** to JPEG: App Store Connect refuses images with an alpha
   channel, and Playwright's PNGs have one
   (`sips -s format jpeg -s formatOptions 92 x.png --out x.jpg`).

The set: the session list with NEEDS INPUT and a working session with
moons, a question card, a permission card, a working session with its
subagents, an image a session read, a diff with the summary table, and New
session.

Apple takes 1 to 10 screenshots per device size; the 6.9-inch set is the only
one required for an iPhone-only app. Redo them when a screen they show
changes noticeably.

### Review video

The video the review notes link to, with the shot list, is in
`mobile/store/app-store.md` → Review video. It uses the same staged data as
the screenshots, and a relay the owner runs from the Docker image, as a user
would. It shows no push to a locked phone, which such a relay cannot send. Record it again when a screen it shows changes noticeably
before a submission, and update the link in the notes.

## Troubleshooting

- **The build does not appear under Add Build**: it is still processing, or
  its export compliance is unanswered, or it is expired (TestFlight builds
  expire after 90 days; upload a new one).
- **"The app name you entered is already being used"**: the name field is
  App Store-wide; the record keeps `Orbital by SlothWorks`.
- **Version string refused**: the version page's version must equal the
  picked build's `CFBundleShortVersionString` and be higher than the last
  version on sale.
- **`ITMS-91053: Missing API declaration`** in the e-mail after an upload:
  the app needs a `PrivacyInfo.xcprivacy` declaring the required-reason API
  named there (a native change).
