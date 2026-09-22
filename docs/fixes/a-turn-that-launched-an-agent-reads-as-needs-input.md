---
id: a-turn-that-launched-an-agent-reads-as-needs-input
title: A turn that launched an agent reads as NEEDS INPUT, and stays there
status: done
type: fix
domain: sessions
related:
  - what-a-session-waits-for-is-a-label
  - background-agents-retire-their-moon-at-launch
  - subagent-liveness-from-sdk-task-events
tags:
  - server
  - runner
  - subagents
---
# A turn that launched an agent reads as NEEDS INPUT, and stays there

## What happens

A web session dispatches a subagent. The map shows NEEDS INPUT and keeps
showing it — through the minutes the agent works, and then through the whole
answer the session streams when the agent lands. Nobody is being waited for.

## What it turned out to be

Two halves of the same assumption: that the human starts every turn.

**1. `result` means "wants you".** `Runner.pump()` answered a turn's `result`
with `setStatus(needs_input)` unconditionally. That was true while `Agent`
blocked. It no longer is — the tool returns at launch and the turn ends with
the agent still out ([[background-agents-retire-their-moon-at-launch]]), so the
CLI ends a turn it is going to resume by itself.

**2. Only `send()` set `working`.** Every `setStatus(..., 'working')` in the
Runner hung off a user action: `send()`, `answerDecision()`, `start()`,
autoheal. A turn the CLI starts on its own — a background agent reporting back,
a queued message, a hook — produces assistant frames and no status change at
all, so the session streamed a whole answer while still labelled `needs_input`.

Both were also feeding the idle timer, which is armed on `needs_input`: a
session whose agent ran longer than `ended_after_idle_minutes` could be ended
by Orbital while it was working.

## The fix

Status is derived from what the CLI is doing, in one place —
`Runner.settleStatus()`:

- a main-loop frame (`parent_tool_use_id == null`) marks the turn running;
  `result` and `interrupt()` mark it over;
- `working` while the turn is running **or** `hasLiveSubagents()` says
  something it launched is still out;
- `needs_input` only when neither holds. A parked decision still owns the
  status outright and keeps its deadlineless park.
- The idle timer moves with the derivation instead of being armed by hand at
  each `result`, so it can never be left running under a `working` session.

`hasLiveSubagents` is injected from the same `SubagentStore` the runner's task
events feed, so liveness has one source.

Two things hung off `needs_input` meaning "a turn just ended" and no longer
can, so the Runner grew an explicit `onTurnBoundary(sessionId, ended)`: the
auto-titler's `considerTurnEnd`, and the republish that carries
`awaitingSubagents` to the map (neither edge necessarily moves the status now).

What the user sees while this is true is [[what-a-session-waits-for-is-a-label]].

## Tests

`server/test/runner.test.ts` — a turn the CLI starts by itself returns to
`working`; a subagent's own frames do not count as one; a turn that ends with a
background agent stays `working` until the agent reports back.
`server/test/subagentsEndToEnd.test.ts` carries the same story end to end
through the REST shape.
