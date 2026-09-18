---
id: the-browser-mints-the-session-id
title: The browser mints the session id, so it can listen before it asks
status: in-force
type: adr
domain: sessions
related:
  - runner-pins-the-session-id
  - first-turn-can-outrun-the-ws-subscription
tags:
  - runner
  - websocket
---
# The browser mints the session id, so it can listen before it asks

## The problem

Launching a session opened a window in which the server could speak and nobody
was listening.

`Runner.start()` returns without waiting for the CLI, by design
([[runner-pins-the-session-id]]), and begins publishing to `session:<id>` as
soon as it has anything. The browser could only subscribe to that topic after
it learned the id — which was the response to `POST /api/sessions`. So the
order was fixed and wrong: start, publish, respond, subscribe. `Hub.publish`
writes to the sockets currently in the topic's set and keeps no backlog, so
anything said in between was gone.

It usually lost nothing, because the CLI needs a second or more to produce its
first assistant message. A slow first paint, a cached reply or a tool-heavy
opening turn was all it would take.

## The decision

The browser mints the id (`crypto.randomUUID()`) and sends it in the request
body. It subscribes to `session:<id>` first, then asks for the session. The
window does not close faster — it never opens.

`POST /api/sessions` takes `sessionId` as an optional field, validates it is a
v4 UUID (the only shape the CLI accepts), and refuses a collision with 409.
Absent, the server mints one exactly as before, so `clear` with `startNew` and
every other internal caller is untouched. `Runner.start()` gained the same
optional parameter, below `resume`, which still wins because a resumed
session's id is already fixed.

This is the same decision [[runner-pins-the-session-id]] made, one step
earlier. That ADR's reasoning was "the id exists before the process does",
which is what let the DB row, the WS topic and the transcript file agree from
the first moment. The id existing before the *request* extends the agreement
to the subscriber.

## The subscribe is imperative

`launchSession` calls `socket.subscribe` directly rather than setting state
and letting `App`'s selection effect do it. Going through React would put a
commit between the decision and the request — which is the same "usually fast
enough" this change exists to stop relying on.

That means the connection could no longer live in `App.tsx`, and it now lives
in `lib/socket` as a lazily-built singleton. Lazy because every test file that
touches the store imports it transitively, and a socket built at import time
would have each of them open a WebSocket against jsdom.

The launch subscription overlaps with the one `App` opens for the selected
session, on purpose. `OrbitalSocket.subscribe` is refcounted and holds several
handlers per topic, so the two coexist and release independently, and a
message delivered twice is harmless: the transcript reducer dedups by message
id, and `status`/`turn_result` are idempotent. The launch subscription is
released when the session ends, the one moment after which its topic can say
nothing further.

## What was rejected

**A replay buffer in the Hub.** It would cover every late subscriber rather
than just this one, which is its appeal. But it answers "how do we catch up
with what we missed" when the better question is why anything was missed —
and it brings a retention policy, per-topic state, and a window that is still
a guess.

**Letting `POST /api/sessions` hold the first prompt** until the client has
subscribed and sends it separately. It removes the window too, at the cost of
an extra round trip and of splitting "launch with a prompt" into two states
the UI would have to model.

## What came with it

`GET /api/sessions/:id/messages` no longer 404s on a session whose transcript
the CLI has not written yet. A row that exists with nothing in it is an empty
transcript, not a missing one, and it now answers `200 { messages: [] }`. An
unknown id still 404s. This was the same moment's noise: the first history
fetch after a launch always failed, `select()` swallowed it, and every launch
left a 404 in the console.
