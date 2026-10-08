---
id: 2026-10-08-notifications-off-by-default-design
title: Notifications start off, and one quiet tip says where they are
status: active
type: spec
domain: settings
related:
  - notifications-start-off-with-a-tip
  - why-orbital
  - 2026-10-08-release-roadmap
tags:
  - notifications
  - settings
  - mobile
---
# Notifications start off, and one quiet tip says where they are

## Problem

`docs/why-orbital.md` promises silence by default, but every notification
switch starts on, sound included (`DEFAULT_NOTIFICATION_SETTINGS` in
`shared/src/notifications.ts`, the `notify_*` rows seeded in
`server/src/db/database.ts`). Turning them off by default keeps the
promise but hides that notifications exist at all
([[notifications-start-off-with-a-tip]]).

## Canvas

`Feature - Notifications off.dc.html` in Claude Design: 1a/1b (desktop,
the tip as a toast at the top centre of the map, offer and after Turn on),
1c (Settings → Notifications at rest), 1d (tip states: offer, on, macOS
refused), 2a–2d (phone, the tip as the first item of the session list),
2e (phone Settings at rest). Decided 2026-10-08: the desktop tip is the
top-centre toast of 1a; the canvas notes that place it at the sidebar foot
are from an earlier version.

## Behaviour

1. **New defaults.** A fresh install has Needs input, Session ended,
   Session failed and Sound off; "Only when Orbital is in the background"
   stays on. The phone's notification rows default off too.
2. **Existing installs keep what they have** and never see the tip. An
   install is existing when its database already held settings before this
   change; it is marked as having seen the tip.
3. **The desktop tip** (1a) appears once, when the first session starts —
   never on an empty first launch, never if any notification setting was
   ever changed. It blocks no clicks, never covers a composer, is never a
   modal or a system notification, and has no entrance motion.
   - *Turn on* switches on Needs input and Session failed; Sound stays off.
     It asks macOS for permission at that moment. The tip then lists what
     changed (1b) and goes after 8 s, paused while hovered. If macOS refuses,
     nothing is switched on and the tip says so with one way to System
     Settings (1d).
   - *Settings →* opens Settings → Notifications; × closes it. Both end the
     tip for good.
   - Once ended — by ×, Settings, the confirmation going, or any setting
     changed — it never comes back, across restarts and updates.
4. **Settings → Notifications** (1c) carries one line, "Everything here
   starts off…", only while every switch is off. "Only when Orbital is in
   the background" is dimmed until something above it is on.
5. **The phone** (2a–2e): the same tip, once, as the first item of the
   session list after pairing, only if the settings it copied from the Mac
   were all off. *Turn on* switches on Needs input and Errors and asks the
   OS for permission then — never at launch, during pairing or on the
   splash screen. A refusal switches nothing on and offers the phone's own
   settings once; it never asks again. 2e's footnote replaces "Copied from
   your Mac when you paired."

## Phone

Built for the phone (rule 5). The desktop and phone tips are each their
own: ending one does not end the other.

## Testing

- Fresh-install defaults and the existing-install rule (server seeding and
  migration).
- When the tip shows and when it never does (pure logic: first session,
  any setting changed, ended), desktop and phone.
- Turn on: exactly Needs input and Session failed (phone: Errors), sound
  off; a refused permission switches nothing on.
