---
id: the-session-list-outgrows-a-relay-frame
title: The session list outgrows one relay frame and the phone shows no sessions
status: done
type: fix
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - 2026-09-28-background-tasks-design
  - the-phone-tunnels-the-api-behind-an-allowlist
tags:
  - server
  - mobile
  - relay
---

# The session list outgrows one relay frame and the phone shows no sessions

## Symptom

A paired phone, online on both the relay and the Mac, showed an empty
session list. Pairing, the tunnel and the hub subscriptions all worked.

## Cause

The phone reads its list with one `GET /api/sessions`, and one REST answer
must fit one relay frame (`MAX_FRAME_BYTES`, 256 KB). On the Mac where it
was found, 50 sessions came to 283 KB, so the Mac answered 413 `too_large`
and the phone kept its empty list.

Four fifths of that was `backgroundTasks`: every session carried every task
it had ever started, ended ones included. One autonomous session alone held
289 tasks (153 KB). The list grew with how much a session had run, not with
how many sessions there were.

## Fix

The list carries a session's current state, not its history.
`toApiSession` lists only the running tasks (`listedBackgroundTasks` in
`server/src/api/shape.ts`) in `GET /api/sessions` and every `sessions`
upsert. Everything that reads a session from the list (the map, the phone's
list, the working checks) asks only what is running. `GET /api/sessions/:id`
carries the whole history.

The web store fetches that detail when a session is selected
(`loadTaskHistory`), and again when a task of the open session ends: the
upsert drops the task, and how it ended is only in the detail. It keeps ended tasks it already holds when a listed
upsert leaves them out (`mergeListedTasks` in `web/src/lib/backgroundTasks.ts`),
because an ended task never changes again. The transcript can therefore
still open the output of any task it launched.

## Phone

The fix is on the Mac only, so a phone build from before it gets its list
back as soon as the Mac is updated. Such a build does not fetch the full
history when a session opens, so it shows only running tasks, and can open
only the output of tasks still running. A phone build that includes the store change
behaves like the Mac.

## Still open

A single session can still outgrow one frame in other ways: a huge
`recentTools` or any other field. The general answer is chunked JSON, the
gap the mobile remote design (§ 8) already names.
