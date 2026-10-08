---
id: a-release-is-a-tag-written-by-one-workflow
title: A release is a tag written by one workflow
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
# A release is a tag written by one workflow

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
- What has shipped is recorded as a git tag: `v<version>` for the desktop
  app, `mobile-v<versionName>` for the phone, `relay-v<version>` for the
  relay image. A version without its tag has not shipped and is shipped by
  the next run. The tag is written only after the upload succeeded.
- A merge without a version bump publishes nothing: no build, no image, no
  moved tag.
- Only the desktop app makes GitHub Releases. The phone and the relay get
  a tag and nothing else.

## Why

- **A tag, not the push's diff.** A diff answers "did this push change the
  version", so a run that failed half way is forgotten by the next push. A
  missing tag keeps asking until the version is out, and a retry is just
  another run.
- **One workflow.** The question "which app has an unshipped version" is
  answered in one tested script instead of three copies of a shell check.
  A failed platform job can still be re-run on its own.
- **Desktop-only Releases.** `electron-updater` takes the repository's
  latest published release as the newest app. A phone release there would
  hide the desktop's from it.

## Alternatives

- **Three workflows**, each with its own path filter and tag check. The
  check would live three times, and the existing `release-mac.yml` would
  set the pattern by accident rather than by choice.
- **A tag push that starts the release workflows.** A tag pushed with the
  workflow's own `GITHUB_TOKEN` does not start other workflows, so this
  needs a personal token in the secrets for no gain over one workflow.
- **Releasing on a hand-pushed tag.** One more step per release, which the
  version bump in the pull request already says.
