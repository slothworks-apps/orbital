---
id: release-to-google-play
title: Release the Android app on Google Play
type: runbook
status: in-force
domain: mobile
related:
  - build-the-android-app
  - release-to-the-app-store
  - ship-the-phone-over-the-air
  - store-review-without-a-mac
  - run-the-relay
tags:
  - mobile
  - android
  - release
---
# Release the Android app on Google Play

The Android app already reaches testers through the Internal testing track
([[build-the-android-app]] → Release to Google Play). This runbook takes a
bundle that is in Play to the Production track: the one-time setup of the
listing and the app content, the first release, and what later releases
need. It is the sibling of [[release-to-the-app-store]], and the decisions
made there hold here: no SlothWorks relay for the public, no push with a
self-hosted relay, 18 and over, data "collected, not shared", not in Russia,
English only, free, released as soon as approved.

The texts for every field (name, short and full description, App access,
the content rating answers, Data safety, the feature graphic prompt) are in
`mobile/store/google-play.md`. Paste from there; change them there first.

## The account decides the gate

SlothWorks' Play developer account is an **organisation** account (SlothWorks
s.r.o.). A personal account created after November 2023 would first need a
closed test with at least 12 testers opted in for 14 days in a row before it
could apply for production; an organisation account goes to production
straight from the console. Nothing here depends on a closed test.

## Before the first release

- **A bundle with the privacy policy link and the "needs Orbital on a Mac"
  line**: native 0.10.0 (versionCode 15) or later, which is already in Play
  from the Internal testing upload. Production takes a bundle Play has; no
  new upload is needed.
- **The website and the privacy policy** say what holds for store users (done
  for the App Store; `mobile/store/app-store.md` → Open points 3, 7).
- **The review video** from the App Store submission, `orbital-app-review.mp4`
  ([[release-to-the-app-store]] → Review video), on Google Drive, shared as
  "Anyone with the link can view". Play takes no attachment; App access
  links it.
- **Screenshots** at 9:16 ([Screenshots](#screenshots)), the 512 × 512 icon,
  and the feature graphic from Claude Design (`mobile/store/google-play.md` →
  Graphics).
- **EU trader status** (Digital Services Act): Play Console → Settings →
  Developer account → Account details → Trader status: SlothWorks s.r.o. is
  a trader. Its address, phone and e-mail are then shown on the EU listing;
  verify them. Without a declaration Play stops offering the app in the EU.

## One-time steps in Play Console

All under the app Orbital in Play Console. The app exists already (created
for Internal testing). The Dashboard's "Set up your app" list links every
step below; Publishing overview lists whatever is still missing.

### 1. Store settings (Grow users → Store presence → Store settings)

- **App category**: App, Productivity; tags as the listing says.
- **Store listing contact details**: e-mail and website from the listing.
- Save.

### 2. Main store listing (Grow users → Store presence → Main store listing)

- **App name**, **Short description**, **Full description**: from the
  listing.
- **App icon**, **Feature graphic**, **Phone screenshots** (all seven, in
  order). Leave the video and the tablet and Chromebook screenshots empty.
- **AI asset declaration** (asked on save): label assets as created or
  edited using AI, and label the feature graphic, which Claude Design made.
  The icon and the screenshots are the app's own artwork and screens.
- Save. The listing is reviewed with the first release.

### 3. App content (Policy and programs → App content)

Each item from `mobile/store/google-play.md` → App content:

1. **Privacy policy**: the URL.
2. **Ads**: no ads.
3. **Sign in details** (called App access until 2026): Yes, restricted, with
   the instruction and the video link. Target audience stays closed until
   this is saved.
4. **Content rating**: start the questionnaire, the e-mail, category All
   Other App Types, the answers in the table; save, then **Submit**. The
   rating applies at once. It comes out at the lowest rating everywhere
   (PEGI 3, ESRB Everyone, IARC 3+); the audience is set separately.
5. **Target audience and content**: 18 and over only; leave "Restrict users
   that Google has determined to be minors" off.
6. **Data safety**: the answers in the tables; at the end, **Submit**. The
   summary shows on the listing once the app is public; it can be edited
   later without a release.
7. **Advertising ID**, **Government apps**, **Financial features**,
   **Health apps**: as the listing says. **App-level trader status and Terms
   of Service**: yes, the account's trader status applies; no Terms of
   Service URL. Check the
   permissions of the bundle (App bundle explorer → the bundle → Details →
   Permissions) before the Advertising ID answer.

### 4. Countries (Test and release → Production → Countries / regions)

**Add countries / regions** → select all → untick Russia → Add. Play applies
the list to the Production track only.

### 5. Production release (Test and release → Production)

- **Create new release**. Play App Signing is on already.
- **App bundles** → **Add from library**: the bundle with the highest
  versionCode (0.10.0, 15, for the first release). Production may take the
  same bundle Internal testing has.
- **Release name**: `<versionName> (<versionCode>)`, Play's default.
- **Release notes** (en-US): from the listing.
- **Next** → **Save** → resolve every error the preview shows. The first
  release had two warnings and no error: no deobfuscation file, and no
  debug symbols for the native code. Both only make crash reports harder to
  read; they can stay.
- **Staged rollout**: 100 % for the first release (there are no users to
  stage); consider a percentage for later native releases. It throttles
  only Play's updates of the native shell; over-the-air bundles are not
  staged by it.

### 6. Send for review (Publishing overview)

The first submission: 2026-11-11, 0.10.0 (15), twelve changes.

- **Managed publishing**: off, so the app goes live as soon as it is
  approved (decided). With it on, approved changes wait for "Publish".
- **Send N changes for review**. The first review of an app can take up to
  seven days; later ones usually a day or less.
- **Rejected**: the reasons come by e-mail and in the Policy status page.
  An access rejection is answered with the App Store review notes and the
  video ([[store-review-without-a-mac]]); a rejection that needs an app
  change needs a new bundle: bump `versionCode` (and `versionName`),
  upload, swap the bundle in the Production release and send it again.

### 7. After approval

1. The listing is live at
   `https://play.google.com/store/apps/details?id=io.slothworks.orbital.mobile`,
   in search after a few hours.
2. **The website**: in `site/src/site.ts` set `PLAY_URL` to that URL, and
   `PHONE_RELEASE` to `public` once the App Store is public too (it switches
   both phone cards at once). The site deploys from `main`.
3. **The app** already links Play on Android (`web/src/mobile/platform/store.ts`).
4. **Internal testing stays.** `npm run android:release` and the `android`
   job keep uploading there; a store release promotes a tested bundle.

## Later releases

| change | how it reaches Play users | new review? |
|---|---|---|
| The app's code (`web/src/mobile`, `shared/`): a bumped app version | An over-the-air bundle through Beam ([[ship-the-phone-over-the-air]]) | No |
| The native shell: a bumped `versionName` and `versionCode` | The `android` job or `npm run android:release` uploads to Internal testing; then Production → Create new release → Add from library, as in step 5 | Yes |
| Store listing texts and graphics | Edit and save; they go to review on their own | Yes, without a release |
| Data safety, content rating | Edit and submit any time | Data safety: no, but it must be true of the version on sale |

Release notes for a native release come from the `mobile/CHANGELOG.md`
lines since the last store version, in the user's words.

Over-the-air bundles fit Play's Device and Network Abuse policy as code run
by an interpreter (JavaScript in the WebView), as long as they do not change
what the app is for; a feature that asks for a new permission or makes the
app something else goes through a native release.

### Screenshots

The App Store set's seven screens, shot again in Chromium at an Android
phone's shape: 396 × 704 points at 3×, 1188 × 2112, 9:16, the ratio Play
needs to show an app in its recommendations. The stack, the pairing and the
live sessions are those of [[release-to-the-app-store]] → Screenshots, steps
1 to 3, with two differences:

- The driver runs with `--android`:
  `node mobile/scripts/store-driver.mjs /tmp/orbital-store-demo --android`.
  Its Chromium profile (`<dir>/chromium`) is separate from the WebKit one, so
  it is paired on its own. The driver's request body has no `require`; read a
  file with `process.getBuiltinModule('fs')`.
- Before each screenshot, evaluate `mobile/scripts/store-android.js` (the
  Android insets, a status bar with the clock on the left, the gesture
  handle) instead of `store-iphone.js`.

Hide the "Jump to the latest message" button before a shot (its
`style.visibility`); a tool call's diff opens with a DOM click on its
`aria-expanded` button, since the path link lies over it. Convert to JPEG as
for the App Store; Play refuses PNGs with alpha too. The set used for the
first release is in `~/Desktop/orbital-google-play/`.

## Troubleshooting

- **"You can't rollout this release because it doesn't allow any existing
  users to upgrade"**: the bundle's versionCode is not higher than one
  already on the track. Pick the newest bundle.
- **"Your app is missing declarations"** in the release preview: Publishing
  overview lists them; answer them under App content.
- **The bundle is not under Add from library**: it was uploaded to another
  app, or is still processing. Bundles uploaded to Internal testing are in
  the library of the same app.
