---
id: 2026-10-19-whats-new-design
title: WHAT'S NEW — the changelog message after an update, on the Mac and the phone
status: active
type: spec
domain: notifications
related:
  - 2026-10-19-headless-server-design
  - any-member-may-update-another
tags:
  - update
  - notice
---
# WHAT'S NEW

## Intent

After Orbital updates, the person using it should see what changed,
once, without looking for it. The canvas "Feature - Notice toast" drew
this message as the `changelog` kind, and "Feature - App update" counts on
it ("after the restart the queue shows the WHAT'S NEW message"). The code
only reserved the kind. Remote update (canvas 50v, step 04) adds one first
line to it after another device updated this Mac.

## What it is

- **The toast.** A notice-toast message of kind `changelog`, in the
  queue's order (update › changelog › relay & pairing › usage limit ›
  tips). Head: `WHAT'S NEW · ORBITAL <version>`, the running version.
  Body: the first three lines of that version's changelog, or after
  skipping versions, of all it tells (§ After skipping versions). One
  action: `See all changes`. Its × ends the message.
- **After a remote update** (50v step 04), the body starts with
  `<Device> updated this Mac at <HH:MM>. The <n> sessions running then
  were stopped.`, and the three lines follow.
- **The dialog** (desktop, canvas 1b):
  - head `WHAT'S NEW` and `Orbital <version> installed today`, or the day
    this Mac first ran the version;
  - the version's sections with their titles; after skipping versions,
    each version's in a block of its own (§ After skipping versions);
  - `Release notes on GitHub ↗` and `Done`.
- **The sheet** (phone, canvas 2b): the sections and `Done`, with no
  install line and no GitHub link. The phone's version is not a GitHub
  release.
- **Closing** the dialog or the sheet ends the message.
- **When it shows.** It shows once after the version changes. It does not
  show on a first install, nor when the changelog has no section for the
  running version. A message for a version left behind, never ended, is
  told with the next one (§ After skipping versions).
- **The first release that carries it.** An existing install has no
  remembered version yet, so a migration (on the phone, existing app
  state) marks it as an update. People already using Orbital therefore
  see it on that release too.

## After skipping versions

Someone who goes from 0.44.0 straight to 0.45.1 sees the notes of both
0.45.1 and 0.45.0, not only the running version's:

- **What is told:** every version newer than the one the device ran
  before and not newer than the one it runs now, newest first. Versions
  compare by number. `Unreleased` never shows. A version with no lines
  is left out.
- **The cap:** at most `WHATS_NEW_MAX_VERSIONS` versions, the newest.
  After a longer gap, the older ones are left out.
- **Only the running version** when nothing earlier is known: a first
  install (no message at all), an install from before WHAT'S NEW, a
  remembered value that is not a version number, or a downgrade (the
  version remembered is not older than the one running).
- **The version before** is remembered with the running one (`from` in
  the remembered value) until the message ends. So a message shown again
  at the next launch still tells the same versions. If a message never
  ended and the device updated again, the next message starts from the
  version the person last saw end.
- **The toast:** the head names the running version. The first three
  lines are the newest version's, filled up from the older ones.
- **The dialog and the sheet:** with one version, as before. With more,
  each version is a block: its number and date, then its NEW, CHANGED
  and FIXED. The blocks go newest first, ruled off from each other. The
  dialog's head and its GitHub link stay on the running version.
- **The bundle:** a build keeps the running version's section and the
  sections before it, up to the cap (shared `recentReleaseSections`). It
  reads the same as the whole file.

## Where the words come from

The app's own changelog, bundled at build time:
- the desktop reads `desktop/CHANGELOG.md`;
- the phone reads `mobile/CHANGELOG.md`.

The sections of the running version and of the versions skipped are
used. Section titles map from Keep a Changelog to the canvas's: `Added` → `NEW`, `Changed` → `CHANGED`,
`Fixed` → `FIXED`, and `Removed` and anything else → `CHANGED`. Lines are
taken as written; they are already written for the person using the app
(root `CLAUDE.md` → Changelogs).

## Scope

- **For whom:** everyone who updates Orbital.
- **Where it lives:** on by default. It is one message in the existing
  notice queue, shown once per version.
- **What someone already using Orbital notices:** after their next
  update, one WHAT'S NEW toast.
- **What can be set:** nothing. × ends it.

## The phone

Built for the phone too: the phone's queue shows the same kind for the
phone app's own version (canvas 2a, 2b sheet), from
`mobile/CHANGELOG.md`. It needs nothing from the Mac, so there is no
`MAC_FEATURES` gate. It ships over the air.

## Design

Canvas "Feature - Notice toast" (1a queue, 1b dialog, 1c kinds; 2a, 2b
phone) and "Feature - Remote update" 50v step 04.
