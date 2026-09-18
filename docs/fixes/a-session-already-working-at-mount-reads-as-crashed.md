---
id: a-session-already-working-at-mount-reads-as-crashed
title: A session already working when the tab opens reads as crashed when it ends
status: done
type: fix
domain: web
related:
  - 2026-09-17-error-surface-design
  - first-turn-can-outrun-the-ws-subscription
tags:
  - web
  - errors
---
# A session already working when the tab opens reads as crashed when it ends

## What happens

`store.ts` decides a session crashed by watching it go `working → ended` with
no `turn_result` between, tracked in the module-level `turnResultSeen` map.
The map is keyed by what *this tab* has observed: an entry appears only when a
`status` event reports `working`.

A session that was already `working` when `loadInitial()` ran never produced
that event here, so it has no entry. When it later ends normally, the check
read `previousStatus === 'working' && !turnResultSeen[id]` — both true — and
the transcript drew *"Session ended unexpectedly — the assistant process may
have crashed."* over a session that did nothing of the sort.

[[2026-09-17-error-surface-design]] made that worse rather than better. The
red row now means two things: with a recorded error it prints the real reason,
without one it falls back to this heuristic. So the false positive was the
*only* case where the row appeared with nothing behind it — empty log, no
Detail button, the sentence the whole story.

## What it turned out to be

Not a missing signal, a collapsed one. `turnResultSeen[id]` has three
meaningful states and `!x` only distinguishes two of them:

- `false` — this tab watched the turn start and never saw it resolve. A crash.
- `true` — a `turn_result` arrived. Not a crash.
- `undefined` — no entry, because this tab never saw the session start a turn
  at all. Ignorance, not evidence. But `!undefined` is `true`, so it was
  counted as a crash alongside the first case.

## What was done

The crash check now requires the flag to be explicitly `false` rather than
merely falsy:

```ts
turnResultSeen[sessionId] === false
```

A session whose turn this tab never watched begin is left alone when it ends,
instead of being accused of a failure nobody observed. The real crash case —
`working` seen here, then `ended` with no `turn_result` — is untouched, and so
is the clearing behaviour on a later `turn_result`. `turnResultSeen`'s type
widened to `boolean | undefined` so the third state is visible at the
declaration, and the doc comment above it now describes all three instead of
recording the false positive as an accepted caveat.

Deliberately not done: seeding the map at `loadInitial()` from each session's
status, or asking the server whether a turn resolved. Both build a mechanism
where the answer is "say nothing when you know nothing" — and the server round
trip in particular buys certainty about a case where the honest reading is
already the right one. Worth revisiting only if a real crash that started
before the tab opened turns out to be something anyone needs to see.

`web/src/test/store.test.ts` covers all three states: already-working-at-mount
ending quietly, the watched crash still flagging, and `working → turn_result →
ended` staying clean.
