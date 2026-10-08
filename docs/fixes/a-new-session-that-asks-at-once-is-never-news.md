---
id: a-new-session-that-asks-at-once-is-never-news
title: A new session that asks for input at once is never notified
status: done
type: fix
domain: remote
related:
  - the-connected-phone-notifies-itself
  - build-the-android-app
tags:
  - notifications
  - shared
---
# A new session that asks for input at once is never notified

## What happens

Start a session in mode `default` whose first step needs a permission
("Create hello.txt using the Write tool", on Haiku). It reaches
`needs_input` within seconds. The phone gets no push and no local
notification; the desktop gets none either.

Seen 2026-10-05 while testing push on the Android emulator: the session sat
in `needs_input` and the relay logged nothing. A session that had answered
once and was then asked for a Write did notify.

## Why

`SessionNotifier.record` (`shared/src/notifications.ts`) treats the first
sighting of a session as a baseline, never as news — right for the sessions
it is seeded with at start (`DeviceWatcher.start`, the desktop's
reconnect), which were already in their state. But a session created
afterwards is also first seen through an upsert, and when the first upsert
the hub sends already carries `needs_input`, the one transition the user
cares about is folded in as the baseline.

## Direction

Tell the two apart: sessions present in the seed are a baseline; a session
first seen after the seed is news if its first state is `needs_input` (or
`ended`). The fold lives in `shared/`, so the fix reaches the desktop, the
Mac's push to the phone and the connected phone alike — a change to all
three apps' changelogs.

## What it actually was, 2026-10-08

The diagnosis above does not hold for a session started through
`POST /api/sessions`. Run against the real server with a fake SDK that asks
for a permission at once, the first `sessions` frame for the new id is an
upsert carrying `working` (`launchSession`), and the `needs_input` that
follows is a status frame, so the desktop notifies and the Mac sends the
phone its wake. What was seen on 2026-10-05 was most likely by design: a
session launched from the phone opens on screen at once, the open session
gets no banner and no system notification, and a connected phone takes the
wake directly, so the relay has no push to log.

Two real gaps turned up on the way, and are what got fixed:

- A terminal session that starts and asks between two registry scans is
  first seen in an upsert already carrying `needs_input`, and was folded in
  as a baseline.
- After a reconnect `reset()` forgets everything, so a status frame saying
  `needs_input` that arrives first for a working session was a baseline too.

`SessionNotifier` now treats a first sighting as news when it is a
question and either arrives in a status frame (the server sends one only
for a change, never as a replay) or in an upsert whose `lastAt` is after
the notifier started listening (a replay of a session that waited for
hours is older than that). Covered in `shared/test/notifications.test.ts`
and `web/src/test/mobilenotify.test.ts`.
