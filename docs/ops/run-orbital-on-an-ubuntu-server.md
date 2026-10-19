---
id: run-orbital-on-an-ubuntu-server
title: Run Orbital on an Ubuntu server
type: runbook
status: draft
domain: remote
related:
  - 2026-10-19-headless-server-design
  - a-headless-orbital-is-a-full-member
  - run-the-relay
tags:
  - server
  - linux
  - deploy
---
# Run Orbital on an Ubuntu server

## What it is

The `orbital` package runs Orbital's server without a window or a map on
an always-on Ubuntu machine. It runs as a systemd user service under one
account, as a member of kind `headless` of the device group. The Mac and
the phone see and drive its sessions through the relay, so they keep
running while the Mac sleeps. Spec: [[2026-10-19-headless-server-design]].

- **Preview:** the package is new. Expect rough edges until it has run
  on a few servers.
- **Supported:** Ubuntu 22.04 and 24.04 on x64 (amd64).
- **Not bundled:** Claude Code. Install it and log in on the server
  yourself.
- **Files:** sessions work on repositories cloned on the server. Nothing
  syncs files between members.

## Once, by the maintainer: the apt repository

The release job publishes to an R2 bucket served at `apt.slothworks.io`.
Before the first release:

1. **Check the package name.** No `orbital` package may exist in Ubuntu's
   archives. Run `apt-cache policy orbital` on a 22.04 and a 24.04 box,
   and search packages.ubuntu.com.
2. **Create the bucket.** Make an R2 bucket and make it public through the
   custom domain `apt.slothworks.io`.
3. **Create a token.** Make an R2 API token scoped to that bucket, with
   object read and write.
4. **Create the signing key.** It signs this repository only:
   ```sh
   gpg --quick-gen-key "Orbital apt repository <orbital@slothworks.io>" ed25519 sign never
   gpg --armor --export-secret-keys <fingerprint>
   ```
5. **Add the repository secrets:**

   | secret | value |
   |---|---|
   | `APT_GPG_PRIVATE_KEY` | the armored secret key from step 4 |
   | `APT_GPG_PASSPHRASE` | its passphrase, if it has one |
   | `R2_ACCOUNT_ID` | the Cloudflare account id |
   | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | the token from step 3 |
   | `R2_BUCKET` | the bucket name |

   Without them the `deb-publish` job in `release.yml` stops at its first step and
   names the missing secrets.

What the job does on each new desktop version:
- It runs after the desktop's GitHub Release is published.
- It builds the `.deb` and attaches it to that Release.
- It adds the `.deb` to the repository, keeping every earlier version.
- It signs the repository, uploads it, and checks it through
  `apt.slothworks.io`.
- It publishes the public key as `https://apt.slothworks.io/orbital.gpg`.
- A run that failed is retried on the next push to `main`, because the
  plan checks whether the repository lists the version yet.

Only the `deb-publish` job holds the key and the R2 token. It runs no npm
and gets the `.deb` from the `deb` job, which builds it from the
desktop's tag.

The signed index carries `Valid-Until`, `APT_VALID_DAYS` ahead.
`apt-resign.yml` signs it again on the first of every month, using the
same secrets.
- **GitHub turns scheduled workflows off** after 60 days with no
  activity in the repository. Check Actions now and then, and turn it
  back on there.
- **After a failure,** start it by hand with Run workflow.
- **If the index expires,** `apt update` on the servers says the Release
  file is expired, and Update fails. Running the workflow fixes it.

## Install

On the server, as the account Orbital should run as (not root).

1. **Install Claude Code** with its native installer, and log in by
   running `claude` once. The native installer puts `claude` in
   `~/.local/bin`, where the service finds it. A `claude` installed with
   npm under nvm is not found: the service starts without an interactive
   shell, and Ubuntu's `~/.bashrc` stops before it loads nvm.
2. **Add the source and install.** The source file must be named
   `orbital.sources`: the updater refreshes only that file.
   ```sh
   sudo install -d -m 0755 /etc/apt/keyrings
   curl -fsSL https://apt.slothworks.io/orbital.gpg | sudo tee /etc/apt/keyrings/orbital.gpg >/dev/null
   printf 'Types: deb\nURIs: https://apt.slothworks.io\nSuites: stable\nComponents: main\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/orbital.gpg\n' \
     | sudo tee /etc/apt/sources.list.d/orbital.sources >/dev/null
   sudo apt update && sudo apt install orbital
   ```
3. **Set up the service:**
   ```sh
   orbital setup
   ```
   It lists the root steps and runs each with `sudo`:
   - records this user in `/etc/orbital/user`;
   - creates the update request directory `/var/lib/orbital/update`;
   - enables the updater;
   - turns on lingering, so the service starts at boot without a login.

   Then it starts the service and prints `orbital status`. Running it again
   changes nothing. A machine runs Orbital for one user.
4. **Set the relay.** Use the same relay as the rest of the group, and set
   it before pairing:
   ```sh
   orbital relay set wss://relay.example --secret   # prompts for the secret
   ```
   Never pass the secret as an argument. To read it from a file in a
   script, use `--secret-stdin`.
5. **Join the group.**
   - **When a Mac manages the group:** click Add a device on the Mac, then
     run `orbital join` and paste its code. The CLI prints a code; type it
     into the Mac's dialog.
   - **When the server starts the group:** a phone shows its own code; run
     `orbital join` and paste it. The server becomes the primary. Later
     devices are added with `orbital devices add`.

## Every day

| | |
|---|---|
| state | `orbital status`, `orbital devices list` |
| server logs | `journalctl --user -u orbital` |
| restart | `systemctl --user restart orbital` |
| port or data dir | `systemctl --user edit orbital`, then `Environment=ORBITAL_PORT=…` (the CLI reads the unit's port too) |
| rename this server | `orbital devices rename <name>` |
| leave the group | `orbital devices leave` |

The data dir is `~/.local/share/orbital` (or `$XDG_DATA_HOME/orbital`).

Do not set `XDG_DATA_HOME` only in a shell profile. The service does not
read the profile, so the CLI and the server would look for the token in
different places. Set it in both, or in neither.

## Updating

When a newer version is in the repository, Settings → Devices on the Mac
and the phone shows "update available" on the server's row. Update
installs it. Any member may press it, and the phone can too. From the
server itself, run `orbital update`, or `orbital update <name>` to update
another member.

How it works:
- The service writes a request file into `/var/lib/orbital/update`.
  `orbital setup` makes that directory owned by the user, mode `0700`.
- The root unit `orbital-update.path` sees it and starts
  `orbital-update.service`.
- That service runs `apt-get update` for `orbital.sources` only, then
  `apt-get install --only-upgrade orbital`.
- The package's `postinst` restarts the user service.
- Running sessions stop. They continue from their transcripts.

The request file's content is ignored, so the request cannot name a
version or a package. The pin in `/etc/apt/preferences.d/orbital.pref`
keeps `orbital` from any other source from winning.

`sudo apt upgrade` works as well.

If an update fails, the row says so. Find the reason here:
```sh
journalctl -u orbital-update
```

To downgrade, run `sudo apt install orbital=<version>`. Every released
version stays in the repository.

## Uninstall

```sh
sudo apt purge orbital
sudo loginctl disable-linger "$USER"   # if nothing else needs it
```

Purge removes `/etc/orbital` and `/var/lib/orbital` and the pin. It keeps
the data dir. Remove the device from the group first, on the primary or
with `orbital devices leave`.

## When something is wrong

- **"Orbital is not running":** run `systemctl --user status orbital`
  and look at the journal. After a reboot, check that lingering is on:
  `loginctl show-user "$USER" -p Linger`.
- **The relay refuses the secret:** `orbital status` names the error. Set
  the secret again with `orbital relay secret`.
- **`orbital` run as root or as another user:** it says which user
  Orbital runs as. Run it as that user (`sudo -u <user> orbital …`).
- **Sessions do not notice new transcripts:** a large
  `~/.claude/projects` can use up the inotify watches. Raise the limit:
  `echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/60-orbital.conf && sudo sysctl --system`.
- **A test build on a Mac:** run `brew install dpkg` (and `gnupg` to sign
  a test repository), then
  `npm run build -w server && node scripts/build-deb.mjs`.
