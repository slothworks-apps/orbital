---
id: spawn-failure-ends-a-session-silently
title: A session whose CLI fails to spawn ends silently, with no reason shown
status: done
type: fix
domain: sessions
related:
  - tilde-expands-at-the-api-boundary
  - 2026-09-17-error-surface-design
  - errors-are-recorded-not-announced
tags:
  - runner
  - errors
---
# A session whose CLI fails to spawn ends silently, with no reason shown

Found while fixing the literal-tilde launch
([[tilde-expands-at-the-api-boundary]]). Not fixed there: that change removes
one cause of a failed spawn, and this is about every other one — a directory
that was deleted, one without permission, a CLI that is missing or broken.

## What happened

`Runner.start()` returns the session id without waiting to hear from the CLI,
by design ([[runner-pins-the-session-id]]). `POST /api/sessions` then writes
the row and returns 201, so the browser closes the dialog and selects a
planet. Meanwhile `pump()` was iterating a generator that throws:

```ts
} catch (err) {
  console.warn('orbital: runner pump error:', err);
}
```

The warning went to the server's terminal. `finish()` then ran as it does for
a clean exit, so the session published `ended` and the planet greyed out. From
the browser the two were indistinguishable: a session that ran and finished,
and a session whose process never started, looked the same.

The user's report was "I launched a session and nothing happened" — which is
precisely what it looked like, with the actual `ENOENT` sitting in a terminal
they were not reading.

## What was there already, and why it was not enough

Not quite nothing, as it turned out. `store.ts` already noticed a session
going `working → ended` with no `turn_result` between and drew a red row
reading *"Session ended unexpectedly — the assistant process may have
crashed."* A failed spawn meets that condition, so the row did appear.

It was a guess over a symptom. It carried no reason, because the reason never
left the server. It needed the client to have subscribed to `session:<id>` in
time, which at launch is [[first-turn-can-outrun-the-ws-subscription]]'s race.
And it lived in memory, so a reload lost it.

## How it was fixed

Not with a `failed` status, and not by making the toast louder. The gap was
that Orbital announced errors and recorded none of them — the same gap on the
synchronous side, where `reportError()` kept `err.message` and discarded the
status code and the response body.

So the fix is a shared error surface, specified in
[[2026-09-17-error-surface-design]] and reasoned about in
[[errors-are-recorded-not-announced]]: an `errors` table the server owns, fed
by `Runner.onError` and by the browser's own failures through
`POST /api/errors`, surfaced as a toast, a list that holds each error until it
is cleared, and a count of the ones nobody has looked at.

The transcript's red row now prints the recorded reason and falls back to the
old sentence only when there is no record — a CLI that exits non-zero without
the generator throwing still produces none, and for that case the guess is
still the most honest thing available.

The open question this doc left — whether the session row should survive when
the process never produced a transcript — is answered: it survives. It is how
the error is reachable in the UI, and revive is built on it.
