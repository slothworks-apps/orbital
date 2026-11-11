---
id: 2026-11-11-app-store-release-handoff
title: "Phone app in the stores — handoff: App Store submitted, Google Play next"
type: session
status: active
domain: mobile
related:
  - release-to-the-app-store
  - build-the-android-app
  - build-the-ios-app
  - store-review-without-a-mac
  - a-paid-slothworks-relay-with-push
  - ship-the-phone-over-the-air
tags:
  - mobile
  - release
  - android
  - ios
---
# Phone app in the stores — handoff

## Where it stands

- **App Store.** The first public submission of the iPhone app was being
  sent on 2026-11-11 (native 0.10.0, build 15; phone app 0.26.0), with
  automatic release after approval. Every step taken is in
  [[release-to-the-app-store]]; the texts and answers are in
  `mobile/store/app-store.md`. Ask the owner whether it went through and
  whether App Review has answered.
- **Google Play.** The app is on the Internal testing track only
  ([[build-the-android-app]] → Release to Google Play). The same 0.10.0
  (15) bundle went to Play with the release that shipped the iOS build.
  Production is the next step, and the subject of the session this handoff
  starts.

What landed: PR #202 (privacy link and "needs Orbital on a Mac" on the
pairing screen, the tag-row fix, the listing, the runbook, the screenshot
and review-video scripts) and PR #203 (the privacy policy and the site's
copy for the public release, a Contact link in the footer).

## Decisions the owner made (apply them to Play too)

- **No SlothWorks relay for the public.** Store users run their own relay
  from the Docker image. A few testers use the owner's relay by
  arrangement. The owner's own phone keeps push through the owner's relay.
- **No push with a self-hosted relay.** The store apps use SlothWorks'
  Firebase project, whose key cannot be handed out, so a user's own relay
  cannot push; notifications show only while the app is open. Accepted for
  the first release. A paid SlothWorks relay or push gateway is an idea
  ([[a-paid-slothworks-relay-with-push]]), not promised anywhere.
- **Age rating 18+.** The questionnaire gives the lowest rating; the owner
  overrode it. On Play: answer the IARC questionnaire truthfully, and set
  Target audience to 18 and over.
- **Data: "not linked", no tracking.** Collected: a device id (Beam's install
  id, Firebase's installation id and token), crash, performance and other
  diagnostics, product interaction; all for app functionality. Play's Data
  safety mapping is in `mobile/store/app-store.md` → For Google Play later.
  The note in [[build-the-android-app]] → Play Console, the first time,
  that "the app collects nothing", is out of date.
- **Not in Russia.** The owner excluded Russia from the App Store's
  availability; do the same in Play.
- **English only**, free, release as soon as approved.
- **No review video filmed on a phone.** The owner's projects are private.
  The video and screenshots come from staged demo data
  ([[release-to-the-app-store]] → Screenshots, Review video).

## What Play will need that the App Store did not

- **Screenshots with a ratio of at most 2:1.** The App Store set is
  1320 × 2868 (2.17:1) and its 1206 × 2622 copy for the 6.3-inch slot;
  Play refuses both. Render a new set from the same flow at a viewport of
  at most 2:1 (for example 440 × 880 at 3×, 1320 × 2640), not by cropping.
- **A feature graphic, 1024 × 500**, and a 512 × 512 icon. The graphic is
  visual design: write a prompt for Claude Design rather than drawing one.
- **Short description, 80 characters.** The full description and title
  come from `mobile/store/app-store.md`.
- **App access** instructions: the App Store review notes say the same
  thing; the review video can be linked or uploaded where Play takes it.
- **The account type decides the gate.** A personal developer account made
  after November 2023 needs a closed test with 12 testers over 14 days
  before production; an organisation account does not. Find out which one
  SlothWorks has before planning dates.
- The site's `PHONE_RELEASE` switches both phone cards at once; set it to
  `public` with `APP_STORE_URL` and `PLAY_URL` once both stores are public
  (`site/src/site.ts`).

## Tools from this work

- `mobile/scripts/store-demo.mjs` stages demo transcripts;
  `mobile/scripts/store-driver.mjs` (loopback, token in `<dir>/driver-token`,
  `--video` to record) drives WebKit at phone size;
  `mobile/scripts/store-iphone.js` adds the safe areas and the 9:41 status
  bar; `mobile/scripts/store-review-video.js` is the review walkthrough.
- Live demo sessions need a logged-in demo Claude directory
  (`CLAUDE_CONFIG_DIR=/tmp/orbital-store-demo/claude claude auth login`,
  gone after a reboot) and the demo projects under `/Users/Shared/Projects`
  (each with a commit and a local `origin`; `fieldnotes` has a `deploy`
  script that only echoes success).
- This Xcode has no Simulator app; the iOS simulator runs headless and
  cannot be tapped, which is why the browser route exists. On Android the
  emulator can be driven with `adb` ([[build-the-android-app]]), but the
  same browser route works there too.
- The finished App Store files are in `~/Desktop/orbital-app-store-screenshots/`.

## How the owner wants to be guided

Czech in chat, documents in English. In a store console, one step per
message: say exactly what to click and what to paste, wait for "hotovo" or
a screenshot, then the next step. Decisions go through AskUserQuestion with
a recommendation first.
