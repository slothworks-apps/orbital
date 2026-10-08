---
id: 2026-10-08-release-roadmap
title: Release roadmap — from stabilization to the public stores
type: plan
status: active
tags:
  - release
related:
  - 2026-10-01-going-public
  - release-the-dmg-from-github-actions
  - the-desktop-app-updates-itself
  - ota-updates-through-beam
  - store-review-without-a-mac
  - 2026-10-06-pairing-code-and-app-lock
  - 2026-10-07-version-compatibility-design
---
# Release roadmap — from stabilization to the public stores

Agreed 2026-10-08. Orbital stops taking on large features. The goal is a
build people other than the maintainer can install and use: first a small
group of testers, then a website, then over-the-air updates, then the
public App Store and Google Play.

The phases run in order. Each one gets its own spec when it is picked up;
this plan only says what belongs where and why. A phase is done when its
exit condition holds.

## Phase 0 — Stabilization

What a tester on another Mac, another `~/.claude` and another phone would
hit first. Nothing outside this list is picked up before Phase 1, and the
rest of `ideas/` and the open rows of
[[feature-parity-with-the-claude-code-cli]] wait until after the public
release.

**Bugs a tester would hit**

- [[a-new-session-that-asks-at-once-is-never-news]]
- [[settings-drafts-lose-the-last-keystrokes-on-a-quick-close]]
- [[desktop-follow-ups]]: the orphaned server after a crash, the unbounded
  waits, the CLI path checks, `ORBITAL_VERSION` not reaching the server.
- [[mobile-follow-ups]]: the notification permission asked on every boot,
  the crash on very large photos, images blanking after cache eviction,
  the placeholder notification icon, no rate limit on relay secrets.

**Security on machines that are not the maintainer's**

- [[2026-10-06-pairing-code-and-app-lock]] — the pairing code, the
  required screen lock and the app lock. A tester's phone drives their Mac,
  which runs Claude with a shell, so access is secured before anyone else
  gets the app. Security goes into access, not into cutting features.
- [[a-revoke-can-slip-between-the-relays-store-read-and-attach]]
- [[unapproved-mcp-json-servers-start-in-orbital-sessions]]

**First run**

- [[notifications-start-off-with-a-tip]]

**How it lands** — one branch per item, stacked on this plan's branch and
merged bottom-up, one squash per pull request, so each fix stays a
revertable commit on `main`. Every item adds its changelog lines; the
version bumps come last, in one pull request, so Phase 1 ships them as one
release. Pull requests of this roadmap carry the `pre-public` label.

**Exit:** every item above is done or consciously moved out.

**Done 2026-10-08** as the stack #45–#59 plus the version bump (desktop
0.24.0, phone 0.7.0, relay 0.4.0). Added on the way: a shell left running
no longer keeps a session working, the phone's icon and splash screen, the
Archipelago theme behind an Experimental switch, the relay knowing no
device names, a shared notice toast, and a first-launch crash on a large
`~/.claude`. The notification for a new session that asks at once turned
out not to be a bug; two real gaps found on the way were fixed instead.
The relay must be deployed at 0.4.0 before the apps: they require it.

## Phase 1 — Builds for testers

A merge to `main` that bumps an app's version builds and ships that app,
and only that app. The bump is already part of the PR and
`check-versions.mjs` already refuses a version that goes back
([[a-shipped-version-never-goes-back]]), so there is no extra manual step.

- **Mac** — `release-mac.yml` builds, signs, notarizes and publishes to
  GitHub Releases ([[release-the-dmg-from-github-actions]]). The new
  public repository has none of its secrets yet; they are set once, by
  the maintainer. The release carries the ZIP and update feed as well as
  the DMG, and the app updates itself from it
  ([[the-desktop-app-updates-itself]]). Close
  [[trim-and-sign-the-desktop-package]] here: pin `electron-builder`, check
  the first notarized DMG with `spctl`.
- **iOS** — the same steps as `npm run ios:release`, on a macOS runner,
  with an App Store Connect API key and the distribution certificate and
  profile from secrets, to TestFlight's internal group
  (`build-the-ios-app`). Watch [[firebase-ios-leaves-cocoapods]]: a clean
  runner is where a pod that stops resolving shows up first.
- **Android** — `publishReleaseBundle` on a runner, with the upload key and
  the Play service account from secrets, to the Internal testing track
  (`build-the-android-app`).
- **Relay** — `relay-image.yml` already publishes the image on every
  change. Nothing new, except that testers need a relay they can reach.

The steps for setting the secrets go into the runbooks
`run-the-desktop-app`, `build-the-ios-app` and `build-the-android-app`.

**Exit:** a version bump merged to `main` puts a new build in front of
testers on all three without anyone touching a Mac, and the Mac app
updates itself to it.

## Phase 2 — Demo data, screenshots and a website

- A script that writes a `~/.claude`-shaped directory of invented projects
  and sessions, as described in [[2026-10-01-going-public]] § 2. The real
  app runs on it with `ORBITAL_CLAUDE_DIR` and `ORBITAL_DATA_DIR`, so
  screenshots always match the app and nothing private shows.
- Screenshots and GIFs from it for the README, the website and, later, the
  store listings and the review video.
- A simple website: what Orbital is, the screenshots, links to the DMG,
  TestFlight and Play. It also hosts the privacy policy both stores ask
  for.

**Exit:** the README has a real screenshot, and the website is live with
working download links and the privacy policy.

## Phase 3 — Over-the-air updates for the phone

[[ota-updates-through-beam]]: the web bundle of `web/src/mobile` ships
through Beam, and the app verifies every bundle against a public key built
into the binary before running it. The plugin has to be in the first
public build, which is why this phase comes before Phase 4. The versions
table in the root `CLAUDE.md` gains the bundle version and the rule for
what can ship over the air and what needs a store build.

**Exit:** a fix to `web/src/mobile` reaches testers' phones without a
store build, and a bundle with a bad signature is refused.

## Phase 4 — Public release in the stores

- Review: the video on the demo data from Phase 2 and the review notes
  ([[store-review-without-a-mac]]).
- Listings: texts, screenshots, Play's Data safety, Apple's privacy
  details, the privacy policy URL from Phase 2.
- The Play developer account belongs to the company, so production is not
  gated behind the closed test of 12 testers over 14 days that a personal
  account would need.
- The apps stay on 0.x until they have been tested by others; the public
  release is the natural point to leave it.

**Exit:** Orbital is downloadable from the App Store and Google Play by
anyone.

## Phone decision

This plan is about how all three apps ship, so the phone is part of every
phase rather than a separate answer: Phase 0 fixes phone bugs and adds the
app lock, Phase 1 builds it, Phase 3 updates it, Phase 4 publishes it.
