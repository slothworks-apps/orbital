---
id: a-reply-is-in-the-transcript-file-but-not-in-the-open-panel
title: A reply reaches the transcript file but not the open panel until View > Reload
type: fix
status: done
domain: web
related:
  - 2026-09-22-ws-reconnect-resync-design
  - the-tail-yields-to-the-runner
  - first-turn-can-outrun-the-ws-subscription
tags:
  - websocket
  - desktop
  - transcript
---

# A reply reaches the transcript file but not the open panel until View > Reload

Reported by Tomin on 2026-09-23, in the desktop app (0.7.1): "regularly,
I type something into the chat and until I do View > Reload I do not see
the reply." Reload shows it, so the CLI answered and the transcript file
has it; what failed is the live path from the server to the open panel.

Not reproduced. This records what was checked, so the next look starts
from the evidence rather than from the code.

## Root cause, found 2026-09-24

The reply arrived while ANOTHER session was selected, and coming back did
not fetch it. `App` subscribes to `session:<id>` only for the selected
session, so while you work in session B nothing listens to A; A's reply
reaches the transcript file and the `sessions` topic (which is why the
planet moved), but never the store. Then `select(A)` saw `historyLoaded[A]`
and returned without asking the server again, so the panel showed A exactly
as it was left: the typed prompt, no reply. Reload rebuilt the store from
the file and it appeared.

That is why it read as "regularly": switching between sessions is what
Orbital is for, and every reply that landed while its session was
deselected was lost to the panel until a reload. Not a socket fault at all
— every candidate below was looking at the wrong hop.

**Fix.** `select()` treats a return to a deselected session as a fresh
open: it fetches the history and replaces the held transcript, carrying
over only an optimistic prompt the file has not echoed yet and whatever the
re-taken subscription delivered while the fetch was in flight. Re-selecting
the session already open still does not refetch, because its subscription
never lapsed. Tests in `web/src/test/store.test.ts` ("select, coming back
to a session"). The resource audit had flagged the same stale cache as a
memory item ([[a-reopened-session-shows-the-transcript-it-was-left-with]]);
the memoisation and batching in that document remain open.

## Verified working

Everything below was checked against the desktop app's own server (the
one it forks on 4737, database in `~/Library/Application Support/orbital`),
not against a dev instance.

- **The server publishes the reply.** An external socket subscribed to the
  topic of a live session received every frame (`thinking`, `tool_use`,
  `tool_result`, `assistant`, `turn_result`, `stats`) as the session
  worked.
- **A revived session publishes too.** A throwaway session was ended and
  then sent into twice — once from a fresh subscription (a tail was
  started), once from a subscription held across the end. The reply
  arrived both times. It arrived *twice* both times, which is the
  duplicate fixed in [[the-tail-yields-to-the-runner]] — a real bug on the
  same path, but the opposite symptom.
- **Session ids stay consistent across resumes.** Every recent transcript
  carries its own id on every entry, so the Runner's `session_id` filter
  is not dropping frames after a `--resume`.
- **The reconnect fix is in the running build.** The heartbeat watchdog and
  the resync-on-reconnect (spec 2026-09-22) shipped in desktop 0.5.0; the
  reported build is 0.7.1.
- **No renderer crashes from the app.** The error log's `render_crash`
  rows are all from dev sessions on 2026-09-20/21 (`localhost:5173`
  stacks); nothing from the packaged app.
- **The transcript view cannot hide an appended row.** Assistant rows are
  never folded into a tool run (`groupToolRuns` only folds tool items),
  the window is `slice(-visibleCount)` so the newest rows are always in
  it, and the entrance animation ends at full opacity with no fill mode
  to get stuck on.

## What the map shows meanwhile

Asked on 2026-09-24: while the reply is missing, the planet reads
**working**. No `reconnecting…` pill was noticed, and the Mac had not
necessarily slept.

Nothing in the web client sets `working` on its own — `sendPrompt` appends
the optimistic bubble and posts, nothing more — so that status came over
the `sessions` topic after the send: the socket was alive and that topic
was delivering at that moment. Two readings remain, and the next
occurrence should tell them apart:

- The turn was still genuinely running (a long, tool-heavy reply), and the
  panel showed none of it. Then `sessions` frames may well be flowing and
  only `session:<id>` is dead — the server no longer holds this socket in
  that topic, or the client never sent the subscribe for it.
- The turn had ended, and the `needs_input` that the Runner publishes on
  `sessions` did not arrive either. Then the whole socket went silent
  without closing — which the watchdog can only miss if the server's
  per-socket heartbeat kept arriving while its topic publishes did not.

Worth noting for the first reading: the map's status and the panel's
transcript come over different topics on the same socket, so "the planet
is working but the panel is empty" is exactly what a lost `session:<id>`
subscription looks like.

## Still open

Candidates that survive the above, none confirmed:

- **A live socket that is no longer subscribed on the server.** The
  watchdog only detects silence; a socket that stays open with heartbeats
  flowing but whose topic subscription was lost would look exactly like
  this. No path that loses one was found in `OrbitalSocket`'s refcounting
  or in `Hub.handleSocket`.
- **Reconnect while the selected session is not on the first page.**
  `resyncAfterReconnect` rebuilds `sessions` from `listSessions`, which is
  one page; a selected session outside it disappears from the map and the
  panel loses its row. Unlikely for a session someone is typing into.
- **A stale pending decision.** `seedDecision` is add-only by design; a
  decision resolved while the session was not selected (its window was
  detached, or it was ended from the map) stays in the store and the next
  typed message is consumed as its answer and never sent. That would show
  as a swallowed message rather than a late reply, and the composer says
  it is answering, so it is a weaker match.
- **Something about the hidden or occluded window.** Close is hide in the
  desktop app, so the renderer lives for days. Chromium throttles timers
  and pauses `requestAnimationFrame` for it, but delivers socket frames;
  no mechanism that would lose a subscription was found.

## Next

1. Ask what the map shows while the reply is missing: does the planet
   read `working`, `needs input` or `ended`; is the `reconnecting…` pill
   ever visible; had the Mac slept or the window been hidden; was the
   session open in a detached window at any point.
2. If that does not settle it, record the socket's lifecycle in the
   client — open, close, watchdog fired, resync ran and what it fetched —
   into the shared error log at reconnect time, so the next occurrence
   carries its own evidence.
