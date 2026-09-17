---
id: 2026-09-17-error-surface-design
title: One error surface — a recorded log, a toast, and an unseen count
status: draft
type: spec
domain: sessions
related:
  - spawn-failure-ends-a-session-silently
  - runner-pins-the-session-id
  - first-turn-can-outrun-the-ws-subscription
tags:
  - errors
  - runner
  - web
---
# One error surface — a recorded log, a toast, and an unseen count

## Why

Orbital has two error paths today and neither says what went wrong.

A call the user just made — rename, launch, clear, save settings — goes
through `reportError()` in `web/src/lib/errors.ts`, which keeps `err.message`
and throws away the HTTP status and the response body. It sets the store's
single `toast` slice, so the next error overwrites it, and nothing is kept.

A session that dies on its own says nothing at all. `Runner.pump()` catches
whatever the SDK generator threw and writes it to the server's terminal:

```ts
} catch (err) {
  console.warn('orbital: runner pump error:', err);   // runner.ts:344
}
```

`finish()` then runs exactly as it does after a clean exit, so the session
publishes `ended` and the planet greys out. A session that ran and finished
and a session whose CLI never started look identical from the browser. The
report behind [[spawn-failure-ends-a-session-silently]] was "I launched a
session and nothing happened", with the real `ENOENT` sitting in a terminal
nobody was reading.

The browser does make one guess. `store.ts` notices a session that went
`working → ended` without a `turn_result` between and sets
`transcriptErrors[id]`, which draws a red row in the transcript reading
*"Session ended unexpectedly — the assistant process may have crashed."*
That is a heuristic over a symptom: it has no reason to show, it needs the
client to have been subscribed in time, and it is gone on reload.

Orbital is a local developer tool. The error text, the stack, the status code
and the response body are all things its user wants to see, and none of them
are reaching them.

## What we are building

One log, owned by the server, fed from both sides, surfaced three ways: a
toast when an error arrives, a list that holds it until it is cleared, and a
count of the ones nobody has looked at yet.

Visual design is deliberately out of scope. The list and the count are built
plain — correct structure, correct state, no styling investment — because a
canvas for them will come later and will be applied to what this spec builds.

## The error record

A row in a new `errors` table (drizzle migration, alongside `settings`):

| column | type | meaning |
|---|---|---|
| `id` | integer pk autoincrement | |
| `at` | integer | epoch ms |
| `source` | text | `server` or `web` |
| `kind` | text | short machine label: `session_failed`, `api_request`, `render_crash` |
| `session_id` | text, nullable | set when the error belongs to one session |
| `message` | text | the one-line summary the toast shows |
| `detail` | text, nullable | stack, `componentStack`, or response body — whatever the long form is |
| `context` | text, nullable | JSON: `cwd`, `permissionMode`, `model`, request URL, HTTP status |
| `seen_at` | integer, nullable | when the list showed this row to the user |

Nothing is trimmed, redacted or summarised on the way in. A local tool has no
one to hide a stack trace from, and the whole point of the change is that the
real text arrives.

Retention is a cap, not a clock: the newest 1000 rows survive, older ones are
pruned on insert. Errors here are rare enough that a cap is only a runaway
guard.

## Server

`server/src/errors/log.ts` owns the table:

- `record(entry)` — inserts, prunes, publishes the row on the hub topic
  `errors` as `{ event: 'error', error }`, and returns it.
- `list({ limit, before })` — newest first, paged the way the sidebar's
  history already pages. It returns the rows *and* `unseen`, the total count
  of `seen_at IS NULL` across the whole table, so a count of 200 is right on
  a page of 50.
- `markSeen(ids | 'all')` — stamps `seen_at`, publishes the change.
- `clear()` — empties the table, publishes the change.

Routes, in `server/src/api/routes.ts`:

- `GET /api/errors?limit=&before=`
- `POST /api/errors` — the browser's own errors, forced to `source: 'web'`
- `POST /api/errors/seen` — `{ ids }` or `{ all: true }`
- `DELETE /api/errors`

`Runner` gains an `onError?(sessionId, err)` dep, called from `pump()`'s
catch. `index.ts` wires it to `record()` with `kind: 'session_failed'`, the
session id, `err.message`, the stack in `detail`, and the session's `cwd`,
`permissionMode` and `model` in `context`. The existing `console.warn` stays
— the terminal should keep saying it too.

The Runner does not learn a new status. `finish()` is unchanged, the session
still ends, and `SessionStatus` stays `working | needs_input | idle | ended`.
What changes is that the reason exists somewhere the browser can read it.

## Web

The store gains an `errors` slice: `ErrorRecord[]`, newest first, plus
`unseenCount` as the server reported it — not counted from the loaded page,
which is only the newest fifty. It is filled on mount from
`GET /api/errors?limit=50` and appended from the `errors` WS topic, which the
app subscribes to alongside `sessions`.

Every arriving record raises the existing single toast, now carrying a
**Detail** button that opens the list. Closing a toast closes the toast and
nothing else — `seen_at` is not touched. The store holds one toast at a time,
so a burst overwrites itself; that is exactly why dismissing one must not
count as having read it.

`reportError()` is rewritten to do both halves: set the toast as it does now,
and `POST /api/errors` with what it currently discards — `ApiError.status`
and the response body into `detail` and `context`.

`ErrorBoundary.componentDidCatch` already holds the error and the
`componentStack`; it posts them as `kind: 'render_crash'`. A failure of the
reporting call itself goes to `console.error` and stops there — the one place
in this design that must not feed itself.

`panels/ErrorLog.tsx`, over the existing `ui/Dialog`: newest first, each row
expandable to its full `detail` and `context`, a copy button per row, and
*Clear all*. Opening it stamps `seen_at` on every row it has loaded — not
only the ones scrolled past, because a list you opened is a list you were
shown. That is the only thing that lowers the unseen count. A record arriving
while the list is already open is stamped too.

The unseen count is exposed by the store and rendered as plainly as possible
until there is a design for it.

## What replaces the guess

The transcript's red row stops being a heuristic and starts being a record:
it reads the session's most recent `errors` row and prints the real message,
with a way through to the detail. Because the row comes from the database, the
reason now survives a reload, which the `transcriptErrors` flag never did.

The heuristic stays underneath it as a fallback. A CLI that exits non-zero
without the generator throwing produces no record, and for that case
*"Session ended unexpectedly"* is still the most honest thing we can say.

## Deliberately not in scope

- **A `failed` session status.** Eight places branch on `SessionStatus`, the
  canvas has no artboard for a failed planet, and the detail panel plus the
  log already answer "what happened".
- **Map changes**, including an exception to the ENDED declutter.
- **Severity levels, filtering, search** in the log.
- **`window.onerror` / `unhandledrejection` capture.** The two producers we
  have cover what we know is being lost.
- **Deleting the session row of a failed launch.** [[spawn-failure-ends-a-session-silently]]
  left this open; the answer is that the row stays. It is how the error is
  reachable in the UI, and revive is built on it.

## Testing

Server: `record` / `list` / `markSeen` / prune against a temp database; the
four routes; and `Runner` driven by a fake `queryFn` whose generator throws —
it must call `onError` and still `finish()` the session.

Web: the store loads the log on mount and appends a WS record; an arriving
record raises a toast; `reportError` posts and sets the toast; the transcript
prints a recorded reason and falls back to the heuristic when there is none;
opening the list stamps `seen_at` and drops the unseen count while closing a
toast does not; `ErrorBoundary` posts a crash.
