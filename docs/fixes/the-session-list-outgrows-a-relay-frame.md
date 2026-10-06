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
how many sessions there were. `subagents` had the same shape: every agent
the session had ever launched.

## Fix

The list carries a session's state, not its history; the history comes with
the detail.

### Running subagents and tasks only

`toApiSession` puts only the running background tasks (`listedBackgroundTasks`
in `server/src/api/shape.ts`) and the subagents not yet ended
(`listedSubagents`) into `GET /api/sessions` and every `sessions` upsert,
including the row-less upsert `publishLiveSession` builds. Everything that
reads a session from the list (the map, the phone's list, the working
checks) asks only what is running. `GET /api/sessions/:id` passes
`{ history: true }` and carries all of them.

Two counts ride along in both shapes, `subagentCount` and
`backgroundTaskCount`: how many the session has had, ended included. The
phone's list rows (`moonsSummary`, `moonsSummaryAsleep`) read them, so
"5 subagents · 1 running" and the asleep row's totals stay right while the
arrays hold only what runs.

The web store reads the detail when a session is selected
(`loadSessionHistory`), and again when a subagent or task of the selected
session drops out of an upsert, since how it ended is only in the detail
(`historyEndedOutOfList`). It keeps the ended ones it already holds when a
listed upsert leaves them out (`mergeListed` / `withHeldHistory` in
`web/src/lib/listedHistory.ts`), because an ended item never changes again.
When the detail lands, it is the truth about what ended; only what the list
still runs is kept from the store (`withDetailHistory`), so a subagent the Mac
forgot in a restart goes. Every reader of the history — the transcript's
`OPEN →` and `OUTPUT →`, the detail panel's chips, the subagent and task
panels, the phone's session screen, its moons sheet and its subagent and task
screens — reads the selected session, and opening a subagent or a task
selects its session first.

A reconnect reads the selected session's detail again on both the desktop
(`resyncAfterReconnect`) and the phone (`resync` in `web/src/mobile/boot.ts`):
the list seated in between carries only what runs.

### The phone's ENDED fold loads when it is opened

`GET /api/sessions` takes an optional `ended` parameter. `ended=exclude`
leaves out the sessions whose computed status is `ended` and that are not
pinned (a pinned ended session is not in the fold; the phone shows it in its
own band), and adds `ended: { count, latestAt }`: what `ended=only` with the
same paging would return. `ended=only` returns those sessions alone. Without
the parameter the route answers as before, which is what the desktop asks.
The query string passes the tunnel's allowlist as it is.

The phone's list (`loadSessions`) asks `ended=exclude` and keeps the summary
in `useMobile` (`endedSummary`). The fold's header (`endedHeading` in
`web/src/mobile/sessionList.ts`) shows the summary's count plus the ended
sessions the store holds that the summary does not count — those that ended
while the phone watched. `web/src/mobile/endedFold.ts` tracks which held ended
sessions the summary does count (ones that reached the store already ended,
from a notification or a republish). Opening the fold the first time reads
`ended=only` and merges it into the store (`mergeSessions`); from then on the
header is the group itself, and every resync reads the fold along with the
list, so seating the list does not empty it. Under a tag filter the summary
cannot say how many ended sessions carry that tag, so the header shows no
count until the fold is read. The tag chips likewise do not list a tag that
only ended sessions carry until then.

`seatSessions` keeps the selected session even when the list leaves it out,
so an ended session open on the phone survives a resync (the forget path
clears the selection before it seats an empty list). A session the store
does not hold at all — a "session ended" notification tapped on a cold
start — is added by `loadSessionHistory` when it is selected, the way the
desktop's `?session=` restore and detached windows fetch a session the first
page did not include.

The notifier stays quiet about an ended session first heard of after the
list was read: `SessionNotifier` only records a session's first sighting,
and "Session ended" needs a `working → ended` transition it has seen.

## Phone

The server half reaches a phone build from before this fix as soon as the
Mac is updated: such a build sends no `ended` parameter, gets every session
as before, and gets its list back because the arrays are trimmed. It does
not read the detail when a session opens, so it shows only running subagents
and tasks, can open only those, and its list rows count only what runs. A
phone build that includes the store change behaves like the Mac.

A phone with this change talking to a Mac from before it gets every session
for `ended=exclude` and no summary. It takes that as the fold already read
and groups everything as before; the counts are absent, and the arrays (the
whole history there) are the count.

Before the first live list (a cold start from the cache), the fold shows
what the cache holds, which is only the ended sessions the phone had read.

## Still open

A single session can still outgrow one frame in other ways: a huge
`recentTools` or any other field. The general answer is chunked JSON, the
gap the mobile remote design (§ 8) already names.
