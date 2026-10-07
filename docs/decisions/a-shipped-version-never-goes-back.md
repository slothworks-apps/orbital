---
id: a-shipped-version-never-goes-back
title: A pull request may keep a shipped version, but never lower it
type: adr
status: in-force
tags:
  - release
related:
  - ci-runs-what-a-change-reaches
  - 2026-10-07-version-compatibility-design
---
# A pull request may keep a shipped version, but never lower it

## Context

Three things ship, each with its own version (root `CLAUDE.md` →
Versions). The `versions` CI job checked that the phone's copies agree and
that no minimum in `shared/src/remote/version.ts` names a version the repo
has not reached. It did not compare anything with the base branch. A pull
request that lowered a version passed. So did a branch cut before a bump
that reset the version on merge. The Mac release refuses a tag that
already exists, but a lower version is a new tag and gets through. The
relay image's version tag is overwritten without a check.

## Decision

`scripts/check-versions.mjs --base <ref>` compares the versions in the
working tree with those at `<ref>`. In a pull request, the `versions` job
fetches the base branch and runs the check against it. The check fails
when:

- `version` in `desktop/package.json` or `relay/package.json`, or
  `versionName` in `mobile/android/app/build.gradle`, is lower than on the
  base;
- `versionCode` is lower than on the base;
- `versionName` changed but `versionCode` did not. Google Play and the App
  Store refuse a build whose code they have already seen.

The check compares with the base branch as it is now, not as it was when
the pull request opened. The checkout of a pull request is the branch
merged into its base, so a bump that has landed on the base since then is
on both sides.

## Rejected

- **Every pull request must raise the version.** Most pull requests ship
  nothing: tests, docs, CI. Whether to bump is asked, not forced (root
  `CLAUDE.md` → Versions). Even a pull request that touches an app's paths
  may decide against a bump, so the paths cannot force one either.
- **Comparing with the latest release or image tag.** That needs a token
  and the network, and it does not run locally. The base branch holds every
  version that has shipped, because a release is built from `main`.
