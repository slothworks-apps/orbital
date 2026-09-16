---
id: first-turn-can-outrun-the-ws-subscription
title: A launched session's first messages can arrive before the client subscribes
status: backlog
type: fix
domain: sessions
related:
  - runner-pins-the-session-id
tags:
  - runner
  - websocket
---
# A launched session's first messages can arrive before the client subscribes

Found while fixing the launch deadlock
([[runner-pins-the-session-id]]). Not fixed there: that change was about
`Runner.start()` returning at all, and this is a separate race that the fix
neither introduced nor removed.

## What happens

`Runner.start()` now puts the first prompt into the input stream before it
returns. The browser only subscribes to `session:<id>` afterwards —
`POST /api/sessions` resolves, `NewSessionDialog` closes, `select(id)` runs,
and the WS `subscribe` frame goes out on the render after that. Anything the
Runner publishes in that window is dropped: `Hub.publish` writes to the
sockets currently in the topic's set and keeps no backlog.

The window is real but usually loses nothing, because the CLI needs a second
or more to produce its first assistant message and the subscription lands
well before that. It is a slow first paint, a fast cached reply, or a
tool-heavy opening turn away from mattering.

The transcript on disk is unaffected — a reload reads it back through
`GET /api/sessions/:id/messages` — so the symptom is a live view missing its
opening messages until the page is reloaded, not lost work.

Related noise from the same moment: that first `GET .../messages` 404s,
because the row is inserted with `project_dir: ''` and the CLI has not
written the transcript yet. `select()` swallows it and leaves
`historyLoaded` unset so a later select retries, which is why nothing breaks.
It does leave a 404 in the console on every launch.

## Worth considering

- Have the client subscribe to `session:<id>` before `POST /api/sessions`
  returns — not possible today, since the id is what the POST returns. It
  would need the browser to mint the id, or a "subscribe to my next launch"
  frame.
- Give `Hub` a small per-topic replay buffer, so a subscriber arriving within
  a second or two of publication still gets what it missed.
- Have `POST /api/sessions` hold the first prompt and let the client send it
  after subscribing — an extra round trip, and it splits "launch with a
  prompt" into two states the UI would have to model.
