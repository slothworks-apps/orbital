---
id: 2026-09-21-session-autoheal-design
title: Session autoheal after a server restart
type: spec
status: draft
domain: sessions
related:
  - runner-pins-the-session-id
---

# Session autoheal after a server restart

## The problem

`server/` runs under `tsx watch`, so every save restarts the process and
kills every `claude` subprocess the Runner owns. A session's status is not
stored — it is derived, `runner` → terminal registry → otherwise `ended`
(`server/src/api/shape.ts`). An empty Runner therefore makes every Orbital
session read `ended` the instant the server comes back, whether it had
finished or not.

Reviving already exists, but only by hand and only lazily: posting a message
to a session the Runner does not know resumes it
(`server/src/api/routes.ts`, `POST /api/sessions/:id/messages`). Dogfooding
Orbital while developing Orbital means walking the map after every save,
opening sessions to find out which ones are actually dead.

The same hole opens on a desktop crash or a machine sleep that kills the
server. Dev just hits it twenty times an hour.

## What autoheal does

At boot, the server resumes the sessions it owned and were still recent
enough to matter, parks them at `needs_input`, and marks the ones that were
cut off mid-turn so the interruption is visible rather than inferred.

It does **not** re-run the interrupted turn. A turn's tool calls have already
had their side effects — commits written, files changed — and replaying a
prompt to "continue" spends tokens the user did not ask for and may repeat
them. The session comes back holding its full context; asking for the missing
piece is the user's call.

## 1. Ownership survives the restart

New column on `sessions`:

```
runner_status TEXT  -- 'working' | 'needs_input' | 'idle', NULL when unowned
```

It is the status the Runner last held for that session, and `NULL` means the
Runner does not own it. A graceful end — the user ending it, the idle timer
firing, the SDK generator completing — clears it. A kill cannot clear it.

That asymmetry is the entire signal. Nothing has to guess from `source` or
`last_at` whether a session ended on purpose or was killed: a non-NULL
`runner_status` at boot means the process that set it never got to finish.

The Runner gains one seam to write it:

```ts
onOwnership?: (sessionId: string, status: SessionStatus | null) => void
```

fired from `start()` with the initial status, from `setStatus()` on every
change, and from `finish()` with `null`. It cannot ride the existing
`onStatus`: `setStatus` is guarded on change and a fresh session's state is
constructed already at `working`, so `onStatus` never fires for the initial
transition — the exact window a save-triggered restart lands in most often.

`index.ts` owns the write, like every other Runner callback that touches the
db.

Second column, for the mark:

```
interrupted_at INTEGER  -- epoch ms, NULL when not interrupted
```

## 2. The boot plan — `server/src/runner/autoheal.ts`

A pure function, so the decision is testable without a server:

```ts
planAutoheal({ rows, now, idleTimeoutMs, cap }): {
  heal: string[]         // resume these
  interrupted: string[]  // subset of heal: killed mid-turn
  expired: string[]      // clear the flag, leave them ended
}
```

Rules:

- A row is a candidate when `runner_status` is not NULL.
- It **heals** when `now - last_at < idleTimeoutMs`. The session would still
  have been alive had the server not died, so the restart is made not to have
  happened. No new setting: the window the user already chose for "how long
  may a session sit idle" is the same question.
- `ended_after_idle_minutes` set to `IDLE_NEVER` has no window to borrow, so
  a named ceiling applies instead. Without one, a boot months later would
  resurrect every session Orbital ever ran.
- It is **interrupted** when it heals and `runner_status === 'working'`.
- Everything else **expires**: the flag is cleared and the session reads
  `ended` exactly as today. The idle timer would have ended it anyway.
- At most `cap` sessions heal, newest `last_at` first. The overflow expires
  and is named in the log — a silently truncated heal reads as "everything
  came back" when it did not.

This is the file that carries tests: state transitions with edge cases, which
is what the repo's test rule asks for.

## 3. Carrying it out — `index.ts`, after `registry.scan()`

For each id in `heal`:

- skip it if the terminal registry holds it — a session live in a terminal
  owns its own CLI and cannot be taken over, the same rule the revive path
  already enforces;
- skip it if its `cwd` no longer exists;
- otherwise

```ts
runner.start({ cwd, prompt: '', permissionMode, model, resume: id })
```

The empty prompt is what makes this cheap: `userMessage` returns `null`, so
nothing is enqueued, the CLI parks on stdin, and `start()` sets
`needs_input`. A process is spawned; no turn runs and no tokens are spent
until the user types.

Concurrency 3, so a boot with ten healable sessions does not fork ten CLIs at
once. A failure to heal one session is recorded through `ErrorLog` and does
not stop the others or the boot.

Each healed session publishes a `sessions` upsert, so an already-open browser
sees the planet come back without a reload.

`source` is left alone. Only Runner-owned sessions carry `runner_status` at
all, so healing never changes whose session it is.

## 4. Showing it

`interrupted_at` is set at boot for every id in `interrupted`, and cleared
when that session's status next reaches `working` — i.e. the next turn it
actually runs. It rides the REST shape as `ApiSession.interruptedAt`, which
is what makes it survive a page reload.

**Session view** — a banner: the turn was interrupted by a server restart,
the conversation is intact, ask again for what is missing.

**Map** — the planet's existing pill badge, reused. `NeedsInputBadge`
(`web/src/map/Planet.tsx`) generalises to a pill taking `{ label, pulse }`;
`INTERRUPTED` is the same pill at the same offsets with the blinking dot
dropped. An interrupted session is also waiting for input, so the two
compete: `INTERRUPTED` wins while `interrupted_at` is set, being the rarer
and more informative of the two, and it clears itself on the next turn.

Nothing about the planet's own geometry changes. The state sheet (artboard
1f) has no interrupted state and `map/visuals.ts` is a value-for-value
transcription of it; inventing one here would put a body on the map that the
canvas does not describe. Reusing an element the canvas already draws is the
honest interim. A proper artboard is a later, separate change.

**Sidebar** — the same chip: `Badge` gains an `interrupted` variant, shown in
place of the status chip while the flag is set.

**Errors panel** — one `ErrorLog` record per boot that healed anything: how
many sessions came back, how many were mid-turn, and which ones the cap
dropped.

## Testing

- `planAutoheal`: the window boundary, the `IDLE_NEVER` ceiling, mid-turn
  classification, the cap's ordering and overflow.
- One server test over `buildServer` with the existing fake `queryFn`: a db
  holding a `working` row comes back with that session active in the Runner
  and `interrupted_at` set; a row outside the window comes back `ended` with
  its flag cleared.

Nothing is tested about the banner rendering its prop or the pill's pixel
offsets.

## Out of scope

- Re-sending or continuing the interrupted turn.
- Healing terminal sessions — Orbital never owned them.
- A planet state on the canvas for `interrupted`.
- Keeping CLI subprocesses alive across a restart. The SDK owns their stdio;
  a surviving process would be unreachable.
