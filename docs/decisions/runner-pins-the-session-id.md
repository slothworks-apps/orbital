---
id: runner-pins-the-session-id
title: Orbital pins the session id instead of waiting for the CLI to announce it
status: in-force
type: adr
domain: sessions
related:
  - map-ended-declutter
tags:
  - runner
  - agent-sdk
---
# Orbital pins the session id instead of waiting for the CLI to announce it

## The problem

Launching a web session did nothing. The New session dialog stayed on its
pending Launch button, an entry appeared in ACTIVE, and no prompt was ever
answered. `POST /api/sessions` never returned — a request left running for
half a minute was still open — and the sessions table had never held a single
`source = 'web'` row.

The entry that appeared was not Orbital's. The spawned CLI writes itself into
`~/.claude/sessions/<pid>.json`, `SessionRegistry` picks that file up and
publishes an `upsert`, so the planet on screen was the terminal registry
noticing a process, not evidence that the launch had worked. Everything
downstream of `Runner.start()` — the DB row, the tag, the transcript — was
still waiting.

`Runner.start()` resolved on the SDK's `system/init` message, and only after
resolving did it put the user's first prompt into the input stream. Probing
`@anthropic-ai/claude-agent-sdk` 0.3.0 (CLI 2.1.272) directly shows why that
can never complete:

| what the caller sends | what comes back |
|---|---|
| nothing, `settingSources: []` | silence — no `init`, nothing at all, indefinitely |
| nothing, hooks configured | the `SessionStart` hook echoes, then silence |
| one user message | `init` at ~1.2 s, then assistant, then result |

In stream-json input mode the CLI parks on stdin and announces the session
only once it has something to work on. Orbital withheld that something until
the announcement arrived. Both sides waited; neither moved.

Every route through the Runner was affected, not just launch: reviving an
inactive session from `POST /api/sessions/:id/messages`, and `clear` with
`startNew`, which asks for a session with an empty prompt and so could never
produce an `init` at all.

The test suite was green throughout. Its fake SDK yielded `init` before
reading the input stream — an ordering the real CLI does not have — so the
deadlock had nowhere to show up.

## The decision

Orbital mints the session id itself (`randomUUID`) and hands it to the CLI as
`options.sessionId`, which the SDK accepts for exactly this purpose. `start()`
registers the session, sends the first prompt, and returns the id
synchronously, without reading a single message off the stream. Message
pumping moved to its own `pump()` method that publishes to
`session:<id>` for the id Orbital already knows.

A resume keeps the transcript's own id: `sessionId` and `resume` are mutually
exclusive in the SDK, and a resumed session's id is already fixed.

The fakes in `server/test/runner.test.ts` now emit `init` only after pulling
the first user message, and derive `session_id` from `options.sessionId ??
options.resume`, so a Runner that goes back to waiting on the stream, or that
stops pinning an id, fails the suite instead of passing it.

## What this changes

- **The id exists before the process does.** The DB row, the WS topic and the
  transcript file the CLI writes all agree on one id from the first moment,
  rather than being reconciled once `init` arrived.
- **A session that dies at startup now surfaces as a session.** `start()` no
  longer rejects with `SDK query ended before init`; a CLI that exits early
  leaves a row that goes `ended`, which the UI can show, instead of a 500 with
  nothing recorded.
- **The in-flight reservation set is gone.** It existed to cover the window
  between `start()` being called and the session appearing in the map once
  `init` landed. Registration is now synchronous, so a second concurrent
  resume of the same id collides on the map itself.

## What was rejected

**Resolve on the first message carrying any `session_id`.** The hook echoes do
arrive before `init` and do carry the id, so this appears to work — on a
machine with `SessionStart` hooks configured. With no hooks the stream stays
silent and the deadlock returns. The fix would have depended on the user's
settings.

**Ask the control protocol.** `Query.initializationResult()` returns commands,
agents, models and account info, but no session id. There is no control
request that reveals it.

**Send a priming message to trigger `init`.** It would burn a turn on nothing,
and it does not help `clear` with `startNew`, whose entire point is a session
that has not been given a turn yet.
