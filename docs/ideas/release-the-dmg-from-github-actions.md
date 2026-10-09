---
id: release-the-dmg-from-github-actions
title: Build, sign, notarize and release the DMG from GitHub Actions
status: done
type: idea
domain: desktop
related:
  - 2026-10-08-builds-for-testers-design
  - 2026-10-01-going-public
tags:
  - release
  - ci
---
# Build, sign, notarize and release the DMG from GitHub Actions

Done: `.github/workflows/release.yml` builds, signs, notarizes and publishes
the DMG when a merged bump raises the desktop version, as
[[2026-10-08-builds-for-testers-design]] describes. The rest of this note is
how it stood before.

## Today

The DMG is built on the maintainer's Mac with `npm run dist`. Signing uses
the Developer ID identity in the local keychain, and notarization uses the
keychain profile named by `APPLE_KEYCHAIN_PROFILE`. The repository has no GitHub releases (checked 2026-10-07): the stale ones
were dropped when it went public.

## Where it stands

`.github/workflows/release-mac.yml` exists, started by hand only
(`workflow_dispatch`). The runbook `run-the-desktop-app` → "Releasing from
GitHub Actions" lists the secrets it needs. It has not run yet: the secrets
are not set. Left to do: the first run, then deciding whether a tag push
should start it too.

## The idea

A workflow on a tag push builds on a GitHub-hosted macOS arm64 runner (free
for public repositories), signs, notarizes and attaches the DMG to a draft
release that the maintainer publishes.

The keychain does not exist on a runner, so the credentials come from
repository secrets instead:

- **Signing:** the Developer ID Application certificate exported as a `.p12`,
  stored base64-encoded, and its password — electron-builder reads them as
  `CSC_LINK` and `CSC_KEY_PASSWORD`.
- **Notarization:** an App Store Connect API key (`.p8`) with its key id and
  issuer id — electron-builder reads `APPLE_API_KEY`, `APPLE_API_KEY_ID` and
  `APPLE_API_ISSUER`. An API key is preferable to an Apple ID with an
  app-specific password: it is not tied to a person's account and can be
  revoked on its own.

The local `dist` script keeps working as it does; the workflow only sets a
different set of variables.

## Until then

Done: the old releases are gone, so there is no stale Latest to fall behind.
The first release comes from the workflow's first run.
