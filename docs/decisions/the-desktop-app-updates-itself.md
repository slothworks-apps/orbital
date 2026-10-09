---
id: the-desktop-app-updates-itself
title: The desktop app updates itself from GitHub Releases
type: adr
status: in-force
domain: desktop
tags:
  - release
  - desktop
related:
  - desktop-startup-window-and-updates
  - release-the-dmg-from-github-actions
  - 2026-10-08-release-roadmap
  - 2026-10-07-version-compatibility-design
  - 2026-10-08-builds-for-testers-design
---
# The desktop app updates itself from GitHub Releases

## Context

On 2026-09-24 an automatic update check was ruled out
([[desktop-startup-window-and-updates]]): it needed a place to publish to
and a check on every launch, for a tool used by one person and a few
colleagues, and a new DMG could be shared by hand.

Both reasons have gone. The repository is public and the DMG is published
to GitHub Releases from Actions ([[release-the-dmg-from-github-actions]]),
and the app is about to go to testers ([[2026-10-08-release-roadmap]]).
A tester who has to download and reinstall a DMG for every fix stays on
an old version, and the fixes of the stabilization phase never reach
them.

## Decision

The desktop app updates itself with `electron-updater`, reading the
releases of the repository on GitHub. It checks on launch and every few
hours while running, downloads a newer version in the background — after
asking, unless the user turned on automatic downloads
([[2026-10-08-builds-for-testers-design]]) — and
installs it when the app next quits; the user can also restart into it
from a quiet prompt. The DMG is needed only for the first install.

- Each release carries, besides the DMG, the ZIP and the `latest-mac.yml`
  feed that `electron-builder` writes for it. Squirrel.Mac installs from
  the ZIP and verifies its signature, so only a Developer ID signed,
  notarized build can update an installed one.
- Only published releases count. A draft is not offered to anyone.
- A dev build and a build run from the repository with `dist:local` or
  `dist:self` do not check.
- Whether the Mac and an older phone can still talk after an update is
  decided by [[2026-10-07-version-compatibility-design]], not here.

How the prompt looks and where it sits is a design question for the
phase's spec; it follows `docs/why-orbital.md`: no badge, no repeated
nagging, nothing that interrupts a running session.

## Alternatives

- **Sharing a new DMG by hand** — what was decided on 2026-09-24. Ruled
  out now: it does not scale past the maintainer.
- **A Homebrew cask** — `brew upgrade` updates only when the user runs it,
  and testers are not all Homebrew users. Still worth adding later as a
  second way to install ([[trim-and-sign-the-desktop-package]]).
- **Shipping only the web bundle over the air**, as the phone will
  ([[ota-updates-through-beam]]). The desktop app also carries the server
  and the Electron main process, which change as often as the web app, so
  a web-only update would cover too little.
