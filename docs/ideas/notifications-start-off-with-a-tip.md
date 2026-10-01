---
id: notifications-start-off-with-a-tip
title: Notifications start off, and a dismissible tip says where to turn them on
status: backlog
type: idea
domain: desktop
related:
  - why-orbital
tags:
  - notifications
  - settings
---
# Notifications start off, and a dismissible tip says where to turn them on

## Today

Every Settings → Notifications switch defaults on, sound included
(`DEFAULT_NOTIFICATION_SETTINGS` in `desktop/src/lib/notifications.ts`, the
`notify_*` rows seeded in `server/src/db/database.ts`). macOS asks for
permission at the first notification Orbital sends; once the user allows it,
every event notifies, with sound, without the user having chosen any of it.

That breaks "Silence by default" in [why-orbital](../why-orbital.md).

## The idea

- Default the switches off, sound included.
- On first launch, show a tip that can be dismissed for good, saying that
  notifications exist and where to turn them on.

## Open questions

- Existing installs: an absent key reads as on today, and users who never
  touched the section have the old defaults stored or implied. Decide whether
  they keep what they have or are moved to the new defaults once.
- Where the tip lives, and how it looks, is a Claude Design question.
