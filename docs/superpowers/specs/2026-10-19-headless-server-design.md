---
id: 2026-10-19-headless-server-design
title: Orbital on an Ubuntu server — a .deb, a systemd service, a terminal CLI, and updating any member from the group
status: active
type: spec
domain: remote
related:
  - 2026-10-16-device-group-design
  - a-headless-orbital-is-a-full-member
  - the-group-has-one-primary-device
tags:
  - remote
  - server
  - linux
---
# Orbital on an Ubuntu server

Part 4 of [[2026-10-16-device-group-design]] (§ 11, § 14), under
[[a-headless-orbital-is-a-full-member]] and
[[the-group-has-one-primary-device]].

## Intent

A Mac sleeps; a small always-on Linux box (an Intel NUC running Ubuntu,
say) does not. With Orbital on that box as a member of the group, the
phone can start and drive Claude sessions at any hour, without the Mac.
The sessions run on the server, under the user's Claude subscription, in
repositories cloned on the server. Nothing syncs files between devices:
the Mac and the phone see and drive the server's sessions, as they do
any member's.

The user should never have to log in to the server for routine work.
Installing and joining happen once in a terminal; after that, updates are
started from the Mac or the phone.

## Goals

1. A `.deb` for Ubuntu on x64, built by the release workflow from the same
   commit and version as the desktop DMG.
2. Installed from a signed apt repository, so `apt upgrade` also works.
3. The server runs as a systemd service under the user's own account, and
   starts at boot without anyone logging in.
4. A terminal CLI: `orbital join` and
   `orbital devices add|join|list|rename|remove`.
5. The server is a full member of kind `headless` (already in
   `shared/src/remote/device.ts` and `serverDeviceKind`).
6. Any member of the group (Mac or phone) sees that the server has a newer
   version available and can start the update. The server installs it and
   comes back. The same works for a Mac: the phone, or another Mac, can
   update it.
7. The Linux fixes from § 11 of the group spec.

## Non-goals

- A map, or the web app, on the server. A web UI over an SSH tunnel stays
  possible later (ADR consequences); it is not built.
- Arm64 Linux, other distributions, Windows. The `.deb` targets Ubuntu LTS
  on x64. Other Debian-based systems may work and are not promised.
- Automatic updates. An update restarts the server and stops its running
  sessions, so it happens only when someone presses Update (or runs
  `apt upgrade`).
- Bundling the Claude CLI. As on the Mac, the user installs `claude` and
  logs in on the server. Orbital finds it on `PATH`.
- Syncing repositories or files between members.

## Anti-goals

- **A public port.** The server binds to `127.0.0.1` like every Orbital
  server, and the other members reach it only through the relay channel.
- **Root for Orbital.** The server never runs as root and holds no sudo
  rights. The only root code is the updater, which can do one thing.
- **An update path that installs anything but a signed Orbital release.**
  A member that presses Update (a stolen phone, say) can make the server
  install only the newest signed `orbital` package from the configured
  repository.

## How it is used

1. On the server, the user installs Claude Code and logs in (`claude`),
   then adds the apt source and runs `sudo apt install orbital`.
2. The package installs the server, the CLI, a systemd user unit, and the
   root updater. A post-install note tells the user to run, as themselves:
   `orbital setup`. That enables the user unit, turns on lingering
   (`loginctl enable-linger`, with sudo if needed), and starts the
   server.
3. The user chooses a relay: `orbital relay set <url>`. As on the desktop,
   the relay must be set before pairing.
4. **Joining a group the Mac manages.** The user clicks Add a device on
   the Mac, which is the primary, and runs `orbital join` on the server.
   The CLI asks for the Mac's code, then prints the code the server shows.
   The user types that code into the Mac's dialog (50c), as for any
   device.
5. **The server as primary** (it was alone, and a phone or another device
   joins it). `orbital devices add` prints a code. When a device asks to
   join, the CLI says the same thing the 50c dialog says:
   `<name> (<kind>, <os>) wants to join. Once in, it sees and drives every
   session on every device in this group.`
   Then it asks for the code that device shows. A wrong code, three
   wrong codes, expiry and `group_full` read as they do in the dialog.
   The phone's own-code sheet gains the line "On a server: orbital join"
   (canvas 50i): a server alone redeems the phone's code and founds the
   group, by the founding rule.
6. **Every day.** The user works from the Mac or the phone. The server's
   sessions show on the Mac's map and in the phone's list like any
   member's.
7. **Updating.** When a newer version is available, the server's row in
   Settings → Devices (Mac and phone) says so and offers Update. Pressing
   it asks for confirmation if sessions are running on the server, then
   the row shows "updating" until the server returns with the new version.

## The CLI

`/usr/bin/orbital`, a Node script shipped in the package. It talks to the
local server over `http://127.0.0.1:<port>` with the token in
`<dataDir>/api-token`, through the same routes the web UI uses
(`server/src/api/remoteRoutes.ts`). It adds no route of its own for
pairing, so the CLI and the UI cannot drift apart.

| command | does |
|---|---|
| `orbital setup` | enables and starts the user unit, turns on lingering, prints the status |
| `orbital status` | server up or not, version, relay, group, primary, members online |
| `orbital relay set <url>` / `orbital relay` | sets or shows the relay, with the same rules as the settings page (locked while in a group) |
| `orbital join [code]` | joins the group whose primary shows the code; alias of `orbital devices join` |
| `orbital devices add` | on the primary, or on a device alone: shows a code and waits for the request and the confirmation described above |
| `orbital devices list` | members with kind, OS, online state and version; marks the primary and this device |
| `orbital devices rename <name>` | renames this device (its self-signed description) |
| `orbital devices remove <name-or-id>` | primary only; the same confirmation as the UI |
| `orbital devices leave` | leaves the group; on the primary, the dissolve confirmation |
| `orbital update [<name>]` | the same update as the Update button: this server, or another member by name (as built, from canvas 50t) |

Errors are written as the UI writes them (`not_primary` names the
primary, and so on), to stderr, with a non-zero exit code. Every command
prints plain text. `--json` is not built.

The renamed device and the remove confirmation reuse the strings the UI
uses. Where a string lives in `web/src` today, move it to `shared/` so
both read one copy.

## The package

- **Contents.**
  - `/usr/lib/orbital/` holds a pinned Node runtime (the major version the
    desktop's Electron runs), the bundled server (`server/dist`), the
    migrations (`server/drizzle`), the CLI, and the runtime externals:
    `better-sqlite3` and `node-pty` built for linux-x64 against that Node,
    and `@anthropic-ai/claude-agent-sdk` without its platform binary
    packages.
  - `/usr/bin/orbital` is the CLI.
  - `/usr/lib/systemd/user/orbital.service` is the server unit.
  - `/usr/lib/systemd/system/orbital-update.service` and
    `orbital-update.path` are the updater (below).
- **The service** runs `/usr/lib/orbital/node /usr/lib/orbital/server/index.mjs`
  with `ORBITAL_HEADLESS=1`, `ORBITAL_RESOLVE_PATH=1` (so `claude` installed
  under the user's home is found), `ORBITAL_MIGRATIONS_DIR` and
  `ORBITAL_VERSION`. It sets no `ORBITAL_STATIC_DIR`. `Restart=on-failure`.
  Logs go to the journal.
- **Version.** The `.deb` carries the desktop's version: it is the same
  server, built from the same commit (root `CLAUDE.md` → Versions gains a
  line saying so). Its changelog is `desktop/CHANGELOG.md`.
- **Supported Ubuntu.** The package is built on Ubuntu 22.04 (runner or
  container), so its native modules load on 22.04 and 24.04, the two
  supported LTS releases.
- **Release.** A new job in `.github/workflows/release.yml`, its own
  target in `scripts/release-plan.mjs`. It counts as shipped when the
  apt repository lists this version, so a failed run is retried on the
  next push. It runs only after the desktop's GitHub Release for the same
  version is published, so a server is never offered a version with no
  DMG. The job builds the package and attaches the `.deb` to that
  Release. It then adds the package to the repository, signs the
  repository's `Release` file with the repository key, and uploads it.
- **The apt repository.** It lives in a Cloudflare R2 bucket served at
  `apt.slothworks.io`. It has one component and one architecture
  (`amd64`), and keeps every released version, so a downgrade stays
  possible (`apt install orbital=<version>`). It is signed by a key
  generated for it. The private key and an R2 token scoped to that one
  bucket are GitHub Actions secrets, and the public key is published in
  the bucket. The maintainer creates the bucket, the domain, the token and
  the key. The runbook says how, and gives the two commands that add the
  source.
- **As built.** The release has two jobs:
  - `deb` builds from the desktop's tag, with no secrets, and runs
    `npm ci --ignore-scripts`.
  - `deb-publish` is the only job that holds the signing key and the R2
    token. It runs no npm and receives the `.deb` as an artifact.

  The index is fetched by hash (`Acquire-By-Hash`). `Release` carries
  `Valid-Until`, `APT_VALID_DAYS` ahead. The monthly `apt-resign.yml`
  signs it again between releases, so a stale index cannot be served
  forever. A version counts as shipped only when `InRelease` matches the
  published `Packages` and lists it.

## Updating from the group

**What the server knows.** Ubuntu's `apt-daily.timer` refreshes the package
lists once a day. The updater's root service also refreshes them when it
starts. The server reads the installed and candidate versions of `orbital`
from `apt-cache policy orbital` (no root needed) at start and every
`UPDATE_CHECK_MS`. It never contacts the repository itself.

**What the members see.** The hello already carries the app version, and
the member row shows it. The update state is not pushed: the hello is
sent once, when a channel opens, and the group's messages carry only the
roster. Instead, a new allowlisted route, `GET /api/server/update`,
answers `{ installed, candidate | null, packaged, updating, sessions }`,
where `sessions` counts the sessions the server is running. Each member,
the phone included, reads it straight from the server, through its own
channel:
- when Settings → Devices is open;
- every `UPDATE_POLL_MS` while it shows the server as `updating`.

A member whose hello names a version below this change's does not have
the route, and the member never asks it.

**Starting it.** A new route, `POST /api/server/update`, on the allowlist.
Any member may call it, through the channel, and so may the local CLI.
The server:
1. refuses with `no_update` when the candidate is not newer, and with
   `not_packaged` when it does not run from the package (a dev server, a
   Mac);
2. answers `202` and marks itself `updating`;
3. writes an update request to a file the root `.path` unit watches.

The caller confirms first when the `GET` reported running sessions.

**One user per machine.** A machine runs one Orbital user. `orbital setup`
(which asks for sudo) records that user in `/etc/orbital/user`. It also
creates the request directory `/var/lib/orbital/update`, owned by
`<user>:root` with mode `0700`, inside the root-owned `/var/lib/orbital`
(`0755`). The directory is not given to the user's group, which may be
shared. Setup also enables the `.path` unit. The server writes the
request without following a symlink (`O_NOFOLLOW | O_EXCL`, after
removing whatever is there). Until setup
has run, the updater does nothing. Uninstall (`apt purge`) removes both.

**The root updater.** `orbital-update.path` watches the request file in
that directory. A change starts `orbital-update.service`, a oneshot. It
runs exactly `apt-get update`, then
`apt-get install --only-upgrade -y orbital`, then deletes the request. It
reads nothing from the request file: the file's content is ignored, so a
request cannot name a version, a package or an option. The package's
`postinst` restarts the user unit of the user in `/etc/orbital/user`
(`systemctl --user -M <user>@ restart orbital`).

**Only our package.** The source line the runbook adds names the
repository's key (`Signed-By`). The package also installs an apt
preferences file that pins `orbital` to the repository's origin, so an
`orbital` from any other source never wins. Before the first release,
check that no package named `orbital` exists in Ubuntu's archives.

**A Mac, too.** The same routes and the same row serve a Mac. On a Mac,
the work goes to the desktop's existing updater
(`electron-updater`, `startUpdates`/`applyUpdateStep` in
`desktop/src/main.ts`), which already checks GitHub Releases every
`UPDATE_CHECK_INTERVAL_MS`:
- The main process and its forked server get a message channel
  (Electron's `utilityProcess` `postMessage` / `process.parentPort`).
  Today they have none. Main tells the server the update state it already
  tracks: installed, available version, and downloading/downloaded. The
  server asks main to start an update.
- On a Mac, `GET /api/server/update` reports that state. `packaged` is
  true when the server runs under the desktop app. A dev server, or a
  server with no parent, reports `not_packaged`.
- `POST /api/server/update` on a Mac asks main to download the update
  and, once downloaded, to install it and relaunch (`quitAndInstall`). This
  is the same step a click on Restart in Settings → Updates takes. Only a
  signed, notarized release from the app's own GitHub Releases can be
  installed this way, which is the same guarantee the apt pin gives the
  server.
- A Mac that sleeps cannot take the request. Its row shows it offline,
  as it does today, and offers no Update.
- Settings → Updates on that Mac reflects an update started from another
  member, because it reads the same updater state.

**Coming back.** Members see the server go offline and return with the new
version, and the row's `updating` clears. If the server returns with the
old version, or does not return within `UPDATE_TIMEOUT_MS`, the row shows
that the update failed. The journal of `orbital-update.service` holds the
reason.

## The Linux fixes

From § 11 of the group spec, with what the code shows today:

- **The data dir.** `server/src/config.ts` and `desktop/src/lib/apiToken.ts`
  hardcode `~/Library/Application Support/orbital`. On Linux, use
  `$XDG_DATA_HOME/orbital`, else `~/.local/share/orbital`. Write it once in
  `shared/` and use it from both.
- **Shells.** `server/src/harness/service.ts` runs verify commands under
  `/bin/zsh`. Use `$SHELL`, else `/bin/sh`. The same applies to the `/bin/zsh`
  fallbacks in `server/src/terminal/store.ts` and
  `server/src/env/loginPath.ts`.
- **The CLI.** `server/src/runner/claudeCli.ts` names the darwin-arm64
  package. In the package it is never present, and the CLI is found on
  `PATH`, which already works. Name the package for the running platform
  and architecture, so a dev checkout on Linux behaves as on the Mac.
- **Native modules.** `better-sqlite3` and `node-pty` are built for
  linux-x64 in the package job (above).
- **Anything else** the first run on Ubuntu shows goes into the runbook,
  or into a `fix` document if it is not fixed in this work.

## The phone

Built for the phone too:
- the server appears as a member, which part 3 already covers;
- the line "On a server: orbital join" in the own-code sheet (50i);
- each member row (server or Mac) shows the version, "update available",
  Update and "updating", through the new allowlisted routes.

The phone updates before the Mac. A Mac from before this change has no
`/api/server/update`. The phone asks that route only of a member whose
hello reports at least this change's version. Gate it in `MAC_FEATURES`
(`mobile/CLAUDE.md`).

## Scope

- **For whom:** two groups.
  - The server: people who keep a Linux server running and want their
    sessions there to outlive the Mac's sleep. That is a small part of
    those who run several sessions at once, and the server adds the most
    upkeep of anything here: an apt repository, its signing key and
    monthly re-sign, a root updater, two Ubuntu releases and a CLI. It is
    built because the always-on member is what the phone needs while the
    Mac sleeps. The runbook marks the package as a preview until its
    reception is known.
  - Remote update: anyone with more than one device in a group, a Mac
    and a phone included. It lets them update a device they are not
    sitting at.
- **Where it lives:** a separate package. Nothing changes on a Mac or a
  phone unless a server joins the group. Then it appears as one more
  member. Remote update is on by default for every member, in the
  member's row.
- **What someone already using Orbital notices:** in a group, a member
  row with a newer version available offers Update. The phone's own-code
  sheet gains one line. Nothing else changes until they install the
  package.
- **What can be set:** the relay (CLI), the device name (CLI), and the
  port and data dir (environment, in a unit override).

## Design

New UI for Claude Design, in the device-group canvas files:
- a member's row (server or Mac) on desktop and phone: version, "update available ·
  <version>", Update, the confirmation when sessions run, "updating", and
  "update failed";
- the 50i line, already drawn.

The CLI's wording follows the dialog it mirrors. It has no canvas.

## Documents this work writes

- A runbook, `docs/ops/run-orbital-on-an-ubuntu-server.md`: install
  Claude Code, add the apt source, install, `orbital setup`, set the
  relay, join, update, logs (`journalctl --user -u orbital`), uninstall.
- The ADR [[a-headless-orbital-is-a-full-member]] moves to `in-force`, and
  a new ADR records the update path (any member may update another; a
  server through an apt repository and a root unit limited to upgrading
  `orbital`, a Mac through its own updater).
- `docs/domains/device-group.md` gains the headless member and the update
  fields.

## Decided in this conversation

- The server is an Intel NUC on Ubuntu; x64 only.
- A ready-made Ubuntu package, not a git checkout.
- Updates are started from the Mac or the phone. The user does not log in
  to the server for them.
- An apt repository plus a root updater that can only upgrade `orbital`.
- Any member may press Update, including the phone.
- No automatic updates. Only on the button, or `apt upgrade`.
- The apt repository is hosted on Cloudflare R2.
- A Mac can be updated from the phone or another member the same way, in
  this same work.

## Calls made while writing, open to change

- The update state is fetched from the server by each member (an
  allowlisted `GET`), not pushed over the channel.
- One Orbital user per machine, recorded by `orbital setup`.
- The `.deb` ships only after the DMG's Release is published, and has its
  own shipped check.
- Built on Ubuntu 22.04, and it supports 22.04 and 24.04.
- The source is bound to the repository key, and `orbital` is pinned to
  the repository's origin.

- Sessions work on repositories cloned on the server. Nothing syncs.
- The service runs under the user's own account (user unit plus linger),
  not as a system user, so it shares the user's `~/.claude`, login and
  repositories.
- The package carries its own Node runtime.
- The `.deb` carries the desktop version and changelog.
- The server learns of new versions from apt's own package lists, not by
  asking GitHub.
- The CLI uses the existing HTTP routes. It has no `--json`.
