---
id: a-new-session-that-asks-at-once-is-never-news
title: A new session that asks for input at once is never notified
status: backlog
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
