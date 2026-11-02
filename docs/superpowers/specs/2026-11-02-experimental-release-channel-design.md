---
id: 2026-11-02-experimental-release-channel-design
title: Experimental release channel — every release reaches experimental first, one Promote moves it to stable
type: spec
status: draft
domain: release
related:
  - a-release-reaches-experimental-before-stable
  - a-version-ships-once-from-one-workflow
  - the-desktop-app-updates-itself
  - 2026-10-08-builds-for-testers-design
  - 2026-10-09-phone-ota-updates-design
  - 2026-10-19-headless-server-design
  - 2026-10-24-group-shared-settings-design
  - an-ota-bundle-runs-only-if-signed-by-ci
  - ship-the-phone-over-the-air
  - run-orbital-on-an-ubuntu-server
tags:
  - release
  - desktop
  - mobile
  - linux
---
# Experimental release channel

**Status: draft**, agreed in conversation 2026-11-02.

## Problem

A merge that bumps a version ships it to everyone at once
([[a-version-ships-once-from-one-workflow]]): the DMG to every Mac, the
`.deb` to every server, the bundle to every phone. The maintainer sees a
release for the first time at the same moment every user gets it. There is
no way to run a release on one's own devices first and let it out only
when it holds.

## Goals

- Every release reaches an **experimental** channel first: the Mac, the
  Linux server and the phone of whoever has it on.
- It reaches **stable** only by hand: one manually started workflow,
  **Promote**, moves the **same versions** to stable on every platform at
  once — no new build, no new signature.
- A hotfix is a release followed by Promote straight away.
- The desktop apps and the phone are always on the same channel.
- One switch, in Settings → Updates, turns experimental on for the whole
  device group.

## Non-goals

- A channel on one platform only, or per device.
- Automatic promotion after a delay.
- A channel for the relay: its image keeps shipping as today.
- Changes to the store builds: TestFlight and Play Internal testing stay
  as they are.
- Prerelease version numbers (`0.46.0-beta.1`): the version that is tested
  is the version that ships.

## Anti-goals

- Turning experimental off downgrades nothing. A device stays on what it
  has until stable passes it.
- A device on stable is never offered a version that has not been
  promoted.
- Promote never rebuilds or re-signs: what was tested is byte for byte
  what stable gets.

## Behaviour

### The switch

`update_channel` is a new setting, `experimental` or absent (stable). It is
**shared by the group** ([[2026-10-24-group-shared-settings-design]]):
added to `SHARED_SETTING_KEYS`, so turning it on on any Mac turns it on on
every Mac and headless server of the group, and the phone reads it like any
other setting. A device without a group has it to itself.

It is a regular feature, not part of the hidden Experimental section
(which parks long-running work in progress): it only brings the regular
release forward. The design is the canvas `Feature - Experimental updates`
(artboards 1a–1h):

- **Settings → Updates**, a third section RELEASES after DOWNLOADS,
  visible to everyone, off by default. One row "Experimental updates"
  with a switch and two lines; the section carries the Shared settings
  marker, widened to "every device in the group" (none when the Mac is
  alone).
- Turning it **on** asks once, inline in the row; turning it **off** asks
  nothing. A mono status line says who turned it on and when, and after
  it is turned off, which version the group stays on until the regular
  release reaches it.
- The word **experimental** shows only while the switch is on, in three
  places: after the version in Settings → Updates (and the check result
  names a found build "an experimental release"), in the update prompt's
  head line (also the remote-update prompt and What's new), and on the
  phone's Version row in Settings → About with one line saying where it
  is changed.
- Nothing on the map, the sidebar, the dock, the menu bar or a Devices
  row.
- On a headless server: `orbital experimental on|off`.

A member from before this feature does not know the key, keeps it as an
unknown shared value or never receives it, and stays on stable. That is
correct: it cannot follow a channel it does not have.

### On the Mac

Releases on GitHub are created as **prereleases**. GitHub's "Latest"
release is never a prerelease.

- **Stable** (`allowPrerelease = false`, today's behaviour):
  electron-updater asks for the Latest release, so a prerelease is never
  seen.
- **Experimental** (`allowPrerelease = true`): electron-updater 6.8.9
  reads the releases feed and takes its first entry, prerelease or not
  (`GitHubProvider.getLatestVersion`, the branch for a stable current
  version with no `channel`).
- Main reads `update_channel` in `loadSettings`, which every check already
  runs first, and sets `autoUpdater.allowPrerelease` from it. A change
  applies at the next check; the switch also triggers a check, so turning
  it on finds the newest release at once.
- The repository has GitHub's immutable releases on. That does not stand
  in the way: a published immutable release can still change whether it is
  a prerelease or the latest (GitHub docs, Immutable releases); only its
  tag and assets are locked. Checked 2026-11-02.
- `autoUpdater.channel` is never set: setting it turns `allowDowngrade` on.
  With `allowDowngrade` off, turning experimental off offers nothing until
  Latest is higher than the installed version.

### On the Linux server

The apt repository gets a second suite, `experimental`, beside `stable`.
Both share the pool and the signing key.

- The release adds each new `.deb` to `experimental` only.
- Promote adds the same pool entry to `stable` and signs the stable index
  (the experimental one does not change).
- `experimental` holds every released version, so its candidate is always
  the newest.

The server chooses its suite through the root updater, which keeps its
rule that nothing the service user writes names a version or a package:

- When `update_channel` changes (a local PATCH or a value synced from the
  group) and at start, the `apt` backend (`server/src/update/backends.ts`)
  writes `/var/lib/orbital/update/channel` with `experimental` or `stable`.
- A second root pair, `orbital-channel.path` (`PathChanged=` on the
  channel file) and `orbital-channel.service`, runs the root script in a
  channel mode; `orbital setup` enables it beside the updater. The request
  pair stays as it is (`PathExists=` would fire forever on a file that
  stays). The update mode applies the channel first too, so an update
  never runs against a stale suite. *(Builder's call.)* The script
  reads it and accepts only the exact word
  `experimental`; anything else, a missing file or a symlink means
  `stable`. It rewrites the `Suites:` line of
  `/etc/apt/sources.list.d/orbital.sources` (only that line, only when it
  differs) and runs `apt-get update` for that source, so `apt-cache policy`
  and Settings → Devices show the right candidate before anyone presses
  Update. A channel change alone installs nothing.
- When `orbital.sources` is not there (a server set up another way), the
  script logs that it cannot switch and changes nothing; the runbook says
  the file name is required. *(Builder's call.)*
- An update request runs as today, against whichever suite the source
  names.
- The pin stays at 990, below 1000, so apt never installs a lower version
  when the suite goes back to stable.
- The channel file is not consumed like the request file: it is a state,
  read each run.

### On the phone

The phone follows the group's `update_channel`: on for experimental,
absent or anything else for production.

- Beam gets a channel `experimental`, `allowSelfAssign: true`,
  `promotesTo: production`.
- The capgo plugin's `setChannel('experimental')` POSTs to Beam's
  `/api/channel_self`, which only checks the channel exists and allows
  self-assignment, and persists the choice on the device; from then on
  every `/updates` request sends it as `defaultChannel`, and Beam answers
  with that channel's bundle. `unsetChannel()` removes it locally (no
  request) and the phone is back on `production`.
- The phone reads `update_channel` from the settings it already reads
  (`settingsSource` in `web/src/mobile/transport/groupFederation.ts`, one
  member, so members in mid-sync cannot make it flip). It keeps its own
  record of the channel it last set (`localStorage`) and calls
  `setChannel`/`unsetChannel` only when the setting differs from that
  record, after the first settings read and on every change. `getChannel()`
  is not used: it is a network call, and its answer can be an admin's
  per-device assignment, which Orbital does not use. *(Builder's call.)* While no member has
  answered yet it does nothing, so a phone that starts offline keeps its
  channel.
- This needs a **native build**: the shipped config has `channelUrl: ''`
  and `allowSetDefaultChannel: false`, and the plugin refuses `setChannel`
  on the latter before any request. The new config sets
  `channelUrl: ${beam.url}/api/channel_self` and
  `allowSetDefaultChannel: true`, and `pinUrls`
  (`web/src/mobile/update/platform.ts`) pins the channel URL to that value
  instead of `''`. An older shell rejects `setChannel` with
  `disabled_by_config`; the phone ignores that and stays on production.
- Turning experimental off downgrades nothing: the replay guard
  (`web/src/mobile/update/guard.ts`) refuses a bundle below its high-water
  mark, so the phone waits until production passes it. A rollback within
  experimental is a new, higher version.
- Compatibility: experimental devices of one group move together, and a
  phone ahead of a Mac is already handled by `MAC_FEATURES`; a Mac ahead
  of the phone by the existing version rules. Nothing new is needed.

### Releasing

`release.yml` keeps deciding what to ship by asking each destination, and
"shipped" now means "in experimental":

| | ships to | shipped when |
|---|---|---|
| mac | a GitHub Release `v<version>`, published as a **prerelease** | the release exists and is not a draft |
| deb | the `experimental` suite | `experimental` lists the version |
| ota | Beam, channel `experimental` | Beam has the bundle (any channel) |
| ios, android, relay | unchanged | unchanged |

- `deb` checks the Release is published as today; a prerelease counts.
- `deb-publish` reads and writes `dists/experimental/…`;
  `scripts/apt-repo.mjs` takes the suite as a parameter instead of the
  constant `SUITE`.
- `apt-resign.yml` signs both suites.
- `ota` uploads with `channel=experimental` (Beam contract below).

### Promote

A new workflow, `.github/workflows/promote.yml`: `workflow_dispatch` only,
no inputs, on `main`, in the `release` concurrency group so it never runs
during a release or a re-sign.

1. **Find what is in experimental** — all reads first, nothing changed:
   - desktop: the newest non-draft GitHub Release by version, and whether
     it is a prerelease;
   - deb: the same version must be listed in `experimental`; if it is not,
     Promote stops (the release has not finished — run Release again);
   - phone: the version Beam's `experimental` channel serves, and the one
     `production` serves.
2. **Move it**, each step skipped when already done, so a re-run after a
   failure finishes the job:
   - apt: add the version's entry to `stable`, sign, upload, check
     `apt.slothworks.io` lists it;
   - GitHub: `gh release edit v<version> --prerelease=false --latest`;
   - Beam: promote the `experimental` bundle's version to `production`.
3. **Report** in the job summary: each platform, from which version to
   which, or "already stable".

The logic lives in a script (`scripts/promote.mjs`, beside
`release-plan.mjs`) with its decisions as pure functions under test; the
workflow only supplies tokens. It needs `contents: write` for the release
edit, the apt secrets, and `BEAM_UPLOAD_KEY`.

Older prereleases that were never promoted stay prereleases; stable
devices skip from the last stable straight to the promoted version.

The manual fallback, if the workflow cannot run, is in the runbooks:
uncheck "Set as a pre-release" and check "Set as the latest release" on
GitHub, promote in Beam's admin, and the apt step by hand.

## Beam contract

Beam (PR #3, `feat/multi-channel-admin-redesign`) has channels,
self-assignment and admin promote. Orbital needs, authenticated with the
app's `X-Upload-Key` like the upload:

1. **Upload into a channel.** `POST /api/apps/:appId/bundles` takes an
   optional multipart field `channel`. With it, the bundle is deployed to
   that channel only and **not** to `production`; an unknown channel is
   `404 { error: 'channel_not_found' }` and nothing is stored. Without it,
   today's behaviour (deploy to `production`), so the current release
   workflow keeps working until this change lands.
2. **Promote by version.**
   `POST /api/apps/:appId/channels/:name/promote` with
   `{ version: string }`: deploys the app's bundle of that version to
   channel `:name`. `200 { status: 'promoted' | 'unchanged', version }` —
   `unchanged` when it is already live there, so a re-run succeeds.
   `404` for an unknown channel or version. The admin route keeps taking
   `bundleId` under the admin JWT.
3. **Read a channel.** `GET /api/apps/:appId/channels/:name`:
   `200 { name, version: string | null }`, the live bundle's version.
4. ~~Not offering a bundle lower than the device's `version_name`~~ —
   not needed. Checked in the plugin (8.51.25): after the replay guard
   refuses a lower production bundle, the plugin finds it already
   downloaded and announces it again without fetching it (Android
   `CapacitorUpdaterPlugin.java` around the "download is NOT required"
   branch; iOS `shouldRetryDownloadForExistingBundle`). A phone switching
   back costs one download.

Beam ships 1–3 before Orbital's release workflow uses them. Beam's part
is built in a separate session, on top of its PR #3; this spec is its
requirement. Orbital's PR merges only after Beam with the contract is
deployed. `promote.mjs` is tested against a stub of these three calls.

## Order

1. Beam: the contract above, deployed; channel `experimental` created on
   the Orbital app.
2. Orbital, one PR:
   - the setting, the Settings row, main's `allowPrerelease`;
   - the Linux channel file, `linux/update`, the path unit, the package;
   - the phone's channel follow, the capacitor config, `pinUrls`, a
     native bump;
   - `release.yml`, `apt-repo.mjs` suites, `apt-resign.yml`,
     `ota-bundle.mjs`/`beam.mjs` channel, `promote.yml` +
     `scripts/promote.mjs`;
   - the runbooks `ship-the-phone-over-the-air`,
     `run-orbital-on-an-ubuntu-server`, `run-the-desktop-app` and a
     domain note on releasing.
3. The release of that PR is itself the first one to land in experimental:
   no shipped device can follow it yet, so it is promoted straight away.
   From then on, devices that turn the switch on get releases first.

The `experimental` apt suite must exist (an empty signed index) before the
first server switches to it; the first release that publishes there
creates it.

## Scope

- **Who it is for:** the maintainer and anyone who wants releases a few
  days early to test them.
- **Where it lives:** an option beside the old behaviour, in Settings →
  Updates, off by default. Not the hidden Experimental section: nothing
  about the switch is work in progress.
- **What someone already using Orbital notices after updating:** one new
  row in Settings → Updates. Releases reach them a little later — after
  Promote.
- **What can be set:** one switch per group.

## Phone

Built for the phone, without a switch of its own: it follows the group
setting it already reads through `/api/settings`, and shows it read-only
on the Version row of Settings → About (design 1g). No new route and no
allowlist change. It needs a native build (the plugin config), so the
phone's native version and app version are bumped; shells from before it
stay on production.

## Versions

Desktop minor (new feature, the Linux package with it), phone minor plus a
native bump (config change). The relay is untouched.

## Left to the builder

- How the server notices a synced value of `update_channel` (a hook in the
  shared-settings sync or a watcher on the settings table).
- How the site's download link handles prereleases: point it at
  `/releases/latest` so a visitor gets stable.
