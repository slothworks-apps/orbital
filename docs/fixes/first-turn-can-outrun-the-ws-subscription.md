---
id: first-turn-can-outrun-the-ws-subscription
title: A launched session's first messages can arrive before the client subscribes
status: done
type: fix
domain: sessions
related:
  - runner-pins-the-session-id
  - the-browser-mints-the-session-id
tags:
  - runner
  - websocket
---
# A launched session's first messages can arrive before the client subscribes

Found while fixing the launch deadlock
([[runner-pins-the-session-id]]). Not fixed there: that change was about
`Runner.start()` returning at all, and this is a separate race that the fix
neither introduced nor removed.

## What happened

`Runner.start()` puts the first prompt into the input stream before it
returns. The browser only subscribed to `session:<id>` afterwards —
`POST /api/sessions` resolved, `NewSessionDialog` closed, `select(id)` ran,
and the WS `subscribe` frame went out on the render after that. Anything the
Runner published in that window was dropped: `Hub.publish` writes to the
sockets currently in the topic's set and keeps no backlog.

The window was real but usually lost nothing, because the CLI needs a second
or more to produce its first assistant message and the subscription landed
well before that. It was a slow first paint, a fast cached reply, or a
tool-heavy opening turn away from mattering.

The transcript on disk was unaffected — a reload read it back through
`GET /api/sessions/:id/messages` — so the symptom was a live view missing its
opening messages until the page was reloaded, not lost work.

Related noise from the same moment: that first `GET .../messages` 404'd,
because the row is inserted with `project_dir: ''` and the CLI has not written
the transcript yet. `select()` swallowed it and left `historyLoaded` unset so a
later select retried, which is why nothing broke. It left a 404 in the console
on every launch.

## How it was fixed

The id is minted by the browser, which subscribes to `session:<id>` before it
sends `POST /api/sessions` — so there is no window to lose anything in. The
reasoning, and the two alternatives this doc listed that were rejected, are in
[[the-browser-mints-the-session-id]].

The subscribe is imperative rather than a React effect, because going through
a commit would restore the same "usually fast enough" the change exists to
remove. That moved the socket out of `App.tsx` into `lib/socket`.

The 404 went with it: a row that exists with no transcript yet answers
`200 { messages: [] }` rather than "transcript missing". An unknown id still
404s.

`web/src/test/launch.test.ts` pins the part that matters — that the subscribe
happens *before* the request, asserted on call order rather than on timing,
and that a message published before anything selects the session still reaches
the transcript.
