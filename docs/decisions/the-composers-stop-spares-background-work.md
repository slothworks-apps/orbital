---
id: the-composers-stop-spares-background-work
title: The composer's Stop stops the turn, not the work running in the background
type: adr
status: in-force
domain: sessions
related:
  - 2026-09-28-background-tasks-design
  - subagent-liveness-from-sdk-task-events
tags:
  - background-tasks
  - subagents
  - composer
---

# The composer's Stop stops the turn, not the work running in the background

## Context

The SDK's `perTaskStopAffordance` option tells the CLI whether the host
can stop background tasks one at a time. Orbital has never declared it,
so the CLI fails closed: an interrupt — the composer's ■ Stop — kills
the session's running background agents and workflows along with the
turn, since otherwise nothing could stop a runaway one short of ending
the session.

The background task list ([[2026-09-28-background-tasks-design]]) gives
tasks a ■ of their own, and its design (26a) has the composer's Stop
leave them running.

## Options

1. **Keep failing closed.** Stop means "stop everything". Interrupting a
   turn to correct the agent also takes down its workflow and its
   subagents mid-flight.
2. **Declare the option, stop tasks one by one.** Stop aborts only the
   turn. Every background task needs its own stop control, or it can only
   be ended with the session.

## Decision

Option 2. The Runner declares `perTaskStopAffordance: true`, and both
lists carry a stop: background tasks in theirs, subagents in the
subagent list, through the same `stopTask` route — the SDK's `stopTask`
takes any task id.

## Consequences

- Correcting the agent mid-turn no longer costs the work it has out.
- A subagent can now be stopped on its own, which it could not before.
- The CLI reads the declaration at initialisation, first attached client
  wins, so it takes effect for sessions started or resumed after the
  change.
- The SDK names agents and workflows as what an undeclared interrupt
  kills. What happens to background shells either way is verified
  against the real CLI when this is implemented.
