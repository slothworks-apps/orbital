---
id: spawn-failure-ends-a-session-silently
title: A session whose CLI fails to spawn ends silently, with no reason shown
status: backlog
type: fix
domain: sessions
related:
  - tilde-expands-at-the-api-boundary
tags:
  - runner
  - errors
---
# A session whose CLI fails to spawn ends silently, with no reason shown

Found while fixing the literal-tilde launch
([[tilde-expands-at-the-api-boundary]]). Not fixed there: that change removes
one cause of a failed spawn, and this is about every other one — a directory
that was deleted, one without permission, a CLI that is missing or broken.

## What happens

`Runner.start()` returns the session id without waiting to hear from the CLI,
by design ([[runner-pins-the-session-id]]). `POST /api/sessions` then writes
the row and returns 201, so the browser closes the dialog and selects a
planet. Meanwhile `pump()` is iterating a generator that throws:

```ts
} catch (err) {
  console.warn('orbital: runner pump error:', err);
}
```

The warning goes to the server's terminal. `finish()` then runs as it does
for a clean exit, so the session publishes `ended` and the planet greys out.
From the browser the two are indistinguishable: a session that ran and
finished, and a session whose process never started, look the same.

The user's report was "I launched a session and nothing happened" — which is
precisely what it looks like, with the actual `ENOENT` sitting in a terminal
they were not reading.

## What it should do

An abnormal end should be distinguishable from a normal one. A `failed`
status, or an `error` event on `session:<id>` carrying the message, would let
the detail panel say what went wrong instead of showing an empty ended
session. `pump()` already has the error in hand; it just has nowhere to put
it.

Worth deciding at the same time whether the session row should survive at all
when the process never produced a transcript.
