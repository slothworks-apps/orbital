---
id: take-over-a-live-terminal-session
title: Take over a session that is live in a terminal
status: backlog
type: idea
domain: server
tags:
  - sessions
---
# Take over a session that is live in a terminal

A session still running in a terminal is read-only in Orbital: `POST
/api/sessions/:id/messages` answers 409 when `ctx.registry` has the id
(`server/src/api/routes.ts`), and the composer refuses input
(`isReadOnly` in `web/src/lib/types.ts`). Once the terminal exits, the
existing revive path already takes the session over — same id, same
transcript, resumed through the SDK. The gap is only the *live* case.

## The feasible shape: signal, wait, revive

The registry (`server/src/watcher/registry.ts`) reads
`~/.claude/sessions/<pid>.json`, so Orbital knows the live session's
pid and its CLI status (`busy` / `idle` / `waiting`). Takeover is then:

1. send the CLI process a termination signal,
2. wait for the registry entry to disappear (dead pid; the watcher
   debounces 200 ms),
3. run the revive path that already exists, with the user's typed text
   as the first turn.

Scope: one endpoint plus a confirm dialog in the web client. The
transcript is append-only JSONL written as the session goes, so
everything already said survives the resume.

Safer variant: allow takeover only while the CLI status is not `busy`
(`idle` / `waiting`), so no in-flight turn is ever cut.

## What was ruled out

A true live attach — terminal and browser both driving the session at
once — is not feasible. The running CLI has no control channel to
inject input from outside, and a second SDK process over the same
transcript means two writers appending one JSONL file.

## Unverified before building

- How the CLI behaves on SIGTERM mid-turn: whether the transcript
  stays consistent, or whether SIGINT (the Esc equivalent) first is
  the cleaner sequence.
- Whether the CLI removes its `sessions/<pid>.json` on SIGTERM. If
  not, the registry still drops the entry via the dead-pid check, only
  after the debounce.
