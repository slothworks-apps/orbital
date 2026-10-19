---
id: any-member-may-update-another
title: Any member of the group may update another, and only to a signed release
status: in-force
type: adr
domain: remote
related:
  - 2026-10-19-headless-server-design
  - a-headless-orbital-is-a-full-member
  - the-group-has-one-primary-device
  - the-phone-may-do-what-the-mac-may
tags:
  - remote
  - update
  - security
---
# Any member of the group may update another

## Context

An always-on server is the member nobody sits at, and a Mac that is
elsewhere is not much easier to reach. Updating a member should not need
an SSH session or a walk to the machine
([[2026-10-19-headless-server-design]]).

## Decision

- Every member serves `GET /api/server/update` and `POST /api/server/update`
  on the allowlist. Any member may call them through its channel, the
  phone included. This is not a primary-only action: an update changes no
  membership, and the phone is never the primary.
- **A server** installs through apt. The unprivileged service writes a
  request file, and a root systemd unit runs only
  `apt-get install --only-upgrade orbital`, from a repository bound to
  its own key (`Signed-By`) and pinned by origin. The request carries
  nothing the unit reads.
- **A Mac** installs through its own updater (`electron-updater`), which
  installs only a signed, notarized release. This Mac's own row in
  Settings → Devices links to Settings → Updates instead of offering a
  second install path.
- No member updates on its own. An update restarts the member and stops
  its running sessions, so it happens only when someone presses Update.
  The caller confirms first when sessions are running.

## Ruled out

- **Primary only.** The phone could not update anything, and the primary
  is the device most likely to be the one being updated.
- **The server updating itself** (download, verify, replace in its home
  directory). That needs no root, but it is not a package the system
  knows, and apt would not see it.
- **Sudo rights for the service.** Any sudo rule broad enough to install
  a package is broad enough to install any package.
- **Automatic updates** (unattended-upgrades). Sessions would stop in the
  middle of work without anyone deciding it.

## Consequences

- A compromised member can make another member restart into the newest
  signed release, at most once per `UPDATE_TIMEOUT_MS` while a failing
  release waits. It can already drive and stop sessions there
  ([[the-phone-may-do-what-the-mac-may]]), so this adds no power.
- The root updater is the only root code Orbital ships. It is a fixed
  script with a fixed command line, and it never reads the request.
