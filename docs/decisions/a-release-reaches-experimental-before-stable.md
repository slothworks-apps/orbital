---
id: a-release-reaches-experimental-before-stable
title: A release reaches experimental first, and one Promote moves the same versions to stable
type: adr
status: in-force
domain: release
tags:
  - release
related:
  - 2026-11-02-experimental-release-channel-design
  - a-version-ships-once-from-one-workflow
  - the-desktop-app-updates-itself
---
# A release reaches experimental first, and one Promote moves the same versions to stable

## Context

Every version bump merged to `main` reached every user at once
([[a-version-ships-once-from-one-workflow]]). The maintainer wants to run
a release on their own devices first, on the Mac, the Linux server and the
phone together, and let it out by hand
([[2026-11-02-experimental-release-channel-design]]).

## Decision

- Each release ships to an experimental channel: a GitHub **prerelease**
  for the Mac, the apt suite `experimental` for Linux, Beam's channel
  `experimental` for the phone.
- A workflow started by hand, Promote, moves the newest experimental
  versions to stable on all three, without building or signing anything.
- The channel is a **group-shared setting**: one switch in Settings →
  Updates moves every Mac, server and phone of the group. It is a regular
  option, off by default, not part of the hidden Experimental section.
- A version has shipped when it is in experimental; this extends "a
  version has shipped when it is where it ships to".

## Rejected

- **electron-updater channels** (`latest-mac.yml` / `beta-mac.yml`).
  They select by the prerelease part of the version, so stable would need
  a rebuilt `0.46.0` after testing `0.46.0-beta.1`: what was tested would
  not be what ships. Setting `autoUpdater.channel` also turns
  `allowDowngrade` on.
- **A per-device switch, the phone following any member on
  experimental.** A group is one person's devices, and what was wanted is
  that they move together; the phone would also have to remember the
  channel of members that are offline. A headless server's
  `orbital experimental on|off` sets the same group setting, not a
  channel of its own.
- **Automatic promotion after a delay.** A release is promoted when it has
  been seen to hold, not when time has passed.
- **Prerelease version numbers.** Promote would mean a second build and a
  second signature.

## Consequences

- Stable users get a release only after Promote; a hotfix is a release
  plus an immediate Promote.
- Turning experimental off downgrades nothing on any platform: the Mac
  never downgrades, the apt pin stays below 1000, and the phone's replay
  guard refuses lower bundles.
- Beam has to take an upload into a channel and a promote by version with
  the upload key.
- The phone's channel needs a native build; older shells stay on
  production.
