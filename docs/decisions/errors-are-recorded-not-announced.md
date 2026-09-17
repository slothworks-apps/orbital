---
id: errors-are-recorded-not-announced
title: An error is recorded first and announced second
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-17-error-surface-design
  - spawn-failure-ends-a-session-silently
tags:
  - errors
  - runner
  - web
---
# An error is recorded first and announced second

## The problem

Orbital announced errors and kept none of them. `reportError()` set a toast
holding `err.message` and dropped the status code and the response body on the
floor; the store holds one toast at a time, so the next error overwrote it.
A session that died on its own did not even get that — `Runner.pump()` wrote
the reason to the server's terminal and `finish()` ended the session exactly
as a clean exit does.

Which left the browser guessing. It still does: a session seen going
`working → ended` with no `turn_result` between draws *"Session ended
unexpectedly — the assistant process may have crashed."* — a sentence
inferred from a symptom, with no reason attached, lost on reload.

## The decisions

### The log is the server's, and it is a table

Not a ring buffer in the tab. The error we most wanted to catch — a CLI that
fails to spawn — happens in the window between `POST /api/sessions` returning
and the browser subscribing to `session:<id>`
([[first-turn-can-outrun-the-ws-subscription]]), so an announcement is exactly
the thing that can be missed. A row in SQLite is there when the client
arrives, survives a reload, and survives a restart of the server.

It also means the browser's own failures post *back* to the server
(`POST /api/errors`) rather than living in a second list. One place to read is
worth a write path the other direction; a panel crash that forced a reload is
precisely the one you would otherwise lose.

Nothing is trimmed on the way in — the full stack, the whole response body.
Orbital runs on the user's own machine, against their own sessions. There is
nobody to withhold a stack trace from, and withholding it is what made the
original bug invisible.

### Seeing happens in the list, never on the toast

`seen_at` is stamped when the error list shows a row. Dismissing a toast
dismisses a toast.

The store holds one toast at a time, so a burst overwrites itself: five
failures in two minutes produce one visible toast and four the user never had
a chance to read. Letting the × count as "seen" would let one click clear a
count standing for four errors nobody saw. The toast is the interruption, the
list is the record, and only the record can say what was read.

### No `failed` session status

The natural move — a fifth member of `SessionStatus` — was ruled out. Eight
places branch on that union, the canvas has no artboard for a failed planet,
and once the reason is recorded the detail panel and the log already answer
"what happened". A new status would buy a distinction on the map at the price
of a design we do not have and a change in every consumer.

The session row of a failed launch stays, too. It is how the error is
reachable in the UI, and revive is built on it.
