---
id: the-clis-running-state-only-adds-to-busy
title: The CLI's own session state can keep a session working, never end its work
type: adr
status: in-force
domain: sessions
related:
  - the-composers-stop-spares-background-work
  - subagent-liveness-from-sdk-task-events
tags:
  - runner
  - status
---

# The CLI's own session state can keep a session working, never end its work

## Context

The runner derives an Orbital session's status itself: `working` while
the main loop's turn runs (from its first frame to its `result`) or while
anything it launched in the background is still alive (from the SDK's
task events), `needs_input` otherwise, and a parked decision owns the
status outright.

The CLI can report its own state as `system/session_state_changed`, with
`state` being `running`, `requires_action` or `idle`. It only sends these
when the child runs with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`. Probed
against the bundled CLI (SDK 0.3.287):

- `running` comes before `init` and lasts past the turn's `result` for
  as long as a background agent is out; `idle` follows the turn the CLI
  starts by itself when the agent reports back.
- `requires_action` and `running` bracket every `canUseTool` call exactly.
- A background shell does not keep it `running`: `idle` follows the
  `result` at once, while the shell runs on.
- An interrupt is followed by `idle` at once.

## Decision

The runner asks for the events and keeps the latest as `cliState`.
`settleStatus()` counts `cliState === 'running'` as busy beside its own
two signals; `awaitingSubagents()` counts it once the turn has ended.
Nothing else reads it.

So the CLI's state can hold a session `working` where Orbital's reading
of the task events missed an agent, but it can never make a session
`needs_input` on its own. A CLI that sends no state (an older one, or
the user's own binary in the packaged app) leaves `cliState` at `null`
and the status exactly as before.

## Ruled out

- **The CLI's state as the only source.** Its `idle` beside a running
  background shell contradicts what Orbital counts as work (adr
  `the-composers-stop-spares-background-work`), and the frames-and-result
  reading still has to exist for CLIs that send nothing.
- **`requires_action` as `needs_input`.** Every wait Orbital can answer
  already arrives as a parked decision through `canUseTool`, at the same
  moment. A `requires_action` with no decision behind it would put up
  NEEDS INPUT for something the user cannot answer from Orbital, and its
  stale value between a settled decision and the next `running` would
  flicker the status.
