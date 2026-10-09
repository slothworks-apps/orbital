---
id: a-version-ships-once-from-one-workflow
title: A version ships once, from one workflow
type: adr
status: in-force
domain: release
related:
  - 2026-10-08-builds-for-testers-design
  - the-desktop-app-updates-itself
  - a-shipped-version-never-goes-back
tags:
  - release
  - ci
---
# A version ships once, from one workflow

## Context

Phase 1 of the release roadmap ships an app or the relay when a pull
request that bumps its version is merged, and only then
([[2026-10-08-builds-for-testers-design]]). Three apps and the relay ship
from one repository, each with its own version, and the Mac app reads its
updates from the repository's GitHub Releases
([[the-desktop-app-updates-itself]]).

Until this decision the relay image was rebuilt on every change under
`relay/` or `shared/`, and each rebuild moved its version tag and `latest`
to code that no version described.

## Decision

- One workflow, `release.yml`, runs on every push to `main`. A small script
  decides what to ship; one job per platform ships it.
- A version has shipped when it is where it ships to: a GitHub Release
  `v<version>` for the desktop app, an image `orbital-relay:<version>` in
  GHCR for the relay. The phone ships to two stores, so each store's
  job writes its own git tag once that store has the build:
  `mobile-ios-v<versionName>` and `mobile-android-v<versionName>`. A
  version that has not shipped is shipped by the next run, per platform.
- A store refusing a build number it already has counts as shipped: the
  job writes its tag instead of failing. The store is the destination,
  and it has the build.
- Nobody tags or marks anything by hand, not even once.
- A merge without a version bump publishes nothing: no build, no image, no
  moved tag.
- Only the desktop app makes GitHub Releases.

## Why

- **Where it shipped, not the push's diff.** A diff answers "did this push
  change the version", so a run that failed half way is forgotten by the
  next push. Asking the destination keeps asking until the version is out,
  and a retry is just another run.
- **The destination, not a tag of our own, where it is cheap to ask.** A
  version that went out by hand — the relay image built before this
  workflow existed — is seen as shipped without anyone writing a tag for
  it. TestFlight and Play are not cheap to ask from a workflow, so the
  phone keeps a tag.
- **A tag per store.** The first phone release went to Play while its iOS
  export failed. With one tag written only when both stores took the
  build, every retry built both, Play refused the build number it already
  had, and the tag could never be written. Per-store tags retry only the
  platform that is missing.
- **A duplicate is shipped, not a failure.** The tag is a note about the
  store, and the store's own answer outranks it: a build that reached the
  store without its tag (a job that failed after the upload, a build
  uploaded by hand) is recorded by the next run, with nobody tagging by
  hand. Only the refusal of that exact build number counts; any other
  refusal still fails.
- **One workflow.** The question "which app has an unshipped version" is
  answered in one tested script instead of copies of a shell check. A
  failed platform job is retried by any later run.
- **Desktop-only Releases.** `electron-updater` takes the repository's
  latest published release as the newest app. A phone or relay release
  there would hide the desktop's from it.

## Alternatives

- **One phone tag for both stores**, the first form of this decision. It
  got stuck after the first release, as above, unless only the failed job
  was re-run in the same run — a rule nobody can follow after a new push.
- **Asking TestFlight and Play for the build** instead of keeping tags.
  The real destination, but each needs its own API client and credentials
  in the plan job; the duplicate refusal gets the same answer from the
  upload that is happening anyway.

- **A git tag for every app**, written by the workflow. Uniform, but a
  version that went out before the workflow needs its tag pushed by hand,
  and the tag can say "shipped" for an image that was since deleted.
- **Three or four workflows**, each with its own path filter and check.
  The check would live several times, and the existing `release-mac.yml`
  would set the pattern by accident rather than by choice.
- **A tag push that starts the release workflows.** A tag pushed with the
  workflow's own `GITHUB_TOKEN` does not start other workflows, so this
  needs a personal token in the secrets for no gain over one workflow.
- **Releasing on a hand-pushed tag.** One more step per release, which the
  version bump in the pull request already says.
