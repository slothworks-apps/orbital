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
  tips). Head: `WHAT'S NEW · ORBITAL <version>`. Body: the first three
  lines of that version's changelog. One action: `See all changes`. Its ×
  ends the message.
- **After a remote update** (50v step 04), the body starts with
  `<Device> updated this Mac at <HH:MM>. The <n> sessions running then
  were stopped.`, and the three lines follow.
- **The dialog** (desktop, canvas 1b) or **the sheet** (phone, canvas 2b):
  - head `WHAT'S NEW` and `Orbital <version> installed today`;
  - the version's sections with their titles;
  - `Release notes on GitHub ↗` and `Done`.

  Closing the dialog or sheet ends the message.
- **When it shows.** It shows once after the version changes. It does not
  show on a first install, nor when the changelog has no section for the
  running version. A message for a version left behind drops out unseen.

## Where the words come from

The app's own changelog, bundled at build time:
- the desktop reads `desktop/CHANGELOG.md`;
- the phone reads `mobile/CHANGELOG.md`.

The section of the running version is used. Section titles map from Keep
a Changelog to the canvas's: `Added` → `NEW`, `Changed` → `CHANGED`,
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
