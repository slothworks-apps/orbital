---
id: release-the-dmg-from-github-actions
title: Build, sign, notarize and release the DMG from GitHub Actions
status: backlog
type: idea
domain: desktop
related:
  - 2026-10-01-going-public
tags:
  - release
  - ci
---
# Build, sign, notarize and release the DMG from GitHub Actions

## Today

The DMG is built on the maintainer's Mac with `npm run dist`. Signing uses
the Developer ID identity in the local keychain, and notarization uses the
keychain profile named by `APPLE_KEYCHAIN_PROFILE`. Releases on GitHub are
uploaded by hand, so they fall behind: the release marked Latest is older
than `version` in `desktop/package.json`, and a stale draft sits next to it.

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

Before the repository goes public, either upload the current DMG by hand and
drop the stale draft, or remove the old releases, so that Latest does not
point at a version several releases behind.
