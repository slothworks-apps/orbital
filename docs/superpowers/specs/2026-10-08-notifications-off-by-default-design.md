---
id: 2026-10-08-notifications-off-by-default-design
title: Notifications start off, and one quiet tip says where they are
status: done
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

## Built 2026-10-08

As specified, with these deviations and details:

- **The notice toast.** The desktop tip is the first message of a shared
  notice toast drawn in Claude Design as `Feature - Notice toast` (1a, 1c,
  2a–2d). Where that canvas and `Feature - Notifications off` disagree, the
  notice toast wins:
  - **Nothing auto-dismisses.** The confirmation after Turn on (1b, 2c)
    stays until × or its Settings link, instead of going after 8 s.
  - The card is the notice toast's: 14/14/14/20 padding, the actions on
    their own row under the text, right-aligned (phone: under the text,
    primary first). The phone's tip is pinned above the session list and
    does not scroll with it, not the first item of the list.
  - A message that goes fades out over 150 ms and the next fades in where
    it was; the first one is simply there.
- **How to add a notice.** `web/src/lib/noticeQueue.ts` holds the kinds in
  showing order (`update › changelog › pairing › usage › tip`, oldest first
  within a kind), the queue functions and `noticeDots`. The Mac's queue is
  `useMapNotices` (`web/src/store/mapNotices.ts`), drawn by
  `ui/MapNoticeHost` at the top centre of the visible map strip with
  `ui/MapNotice` as the card; the phone's is `usePhoneNotices`
  (`web/src/mobile/notices.ts`), drawn by `PinnedNoticeHost` with
  `PinnedNotice` (`web/src/mobile/PinnedNotice.tsx`). A feature pushes
  `{ id, kind, Body }` when its message is due, `dismiss`es it while it is
  not yet showing if it stops applying, and its `Body` renders the card and
  calls `close` on × or any action — after persisting that the message
  ended, wherever that message keeps it (the tip: `notify_tip` on the Mac,
  `orbital.notificationsTip` on the phone). Only the `tip` kind exists so
  far.
- **Existing installs** are told apart by migration
  `0027_notifications_off_by_default`: on a database whose settings table
  already holds rows, it writes `notify_tip = ended` and every `notify_*`
  row that was missing at its old value (`true`). A fresh database runs it
  before the boot seed, so nothing is written and the seed writes the new
  defaults and `notify_tip = pending`. `parseNotificationSettings` now reads
  an absent event or sound as off and an absent background-only as on.
- **"Any setting changed"** is enforced by `PATCH /api/settings`: a changed
  `notify_*` row ends the tip. The phone's tip ends when a switch is changed
  in its Settings.
- **"The first session starts"** is read as: a session that has not ended
  is on the map. A fresh install whose `~/.claude` already has live terminal
  sessions shows the tip at launch.
- **macOS permission.** Electron has no notification-permission API on
  macOS, and macOS asks only when an app shows its first notification. So
  Turn on shows one silent notification ("Notifications are on.") and reads
  how it went (`desktop/src/lib/notificationPermission.ts`): `show` means
  allowed, and the notification is closed again at once; `failed` means
  refused, and nothing is switched on (1d). If neither comes within a minute
  (the system prompt left unanswered), it counts as allowed: the user asked
  for notifications and macOS holds them until its question is answered.
  That `failed` is what a refusal produces was read from Electron's
  UNNotification implementation, not observed on a refusing Mac; check it in
  the packaged app. "Open System Settings" opens Notifications in System
  Settings — macOS has no public link to one app's page. In a browser, Turn
  on switches on without asking.
- **Settings → Notifications** (1c) has the one line and the dimmed
  background-only row. Its rows keep their existing wording and order
  ("A session needs your input", WHEN / HOW); the canvas's labels, DELIVERY
  order and permission footer were left for the fidelity pass.
- **The phone** no longer asks for the permission at launch or at pairing:
  `registerPush` only sends a token when it is already granted, and
  `askForNotifications` asks — when the state is `prompt` only — from Turn
  on and from a switch turned on in Settings (saved either way). The tip is
  due once a pairing marks it `pending` (outside the cache prefix, so
  forgetting a Mac does not offer it again; a phone paired before this has
  no row and never sees it) and while the rules the Mac copied are all off.
  "Open phone settings" is a small Android plugin
  (`NotificationSettingsPlugin`, this app's notification page) and
  `app-settings:` on iOS. The Android plugin was not compiled here: this Mac
  has no JDK 21 for the Capacitor modules.
- The desktop's Settings → opens Settings on Notifications for that visit
  only, the way the harness templates' way in does.
