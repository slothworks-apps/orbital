---
id: what-a-session-waits-for-is-a-label
title: What a session is waiting FOR is a label, not a fifth status
status: in-force
type: adr
domain: sessions
related:
  - a-turn-that-launched-an-agent-reads-as-needs-input
  - subagent-liveness-from-sdk-task-events
  - background-agents-retire-their-moon-at-launch
tags:
  - server
  - subagents
  - map
---
# What a session is waiting FOR is a label, not a fifth status

## The problem

`Agent` runs in the background. The CLI's main loop launches one, finishes its
turn and emits `result` — and then wakes itself back up, minutes later, when
the agent reports in. For that whole gap the session is doing nothing of its
own, and nothing it does next depends on the human.

Orbital had exactly four words for a session: `working`, `needs_input`, `idle`,
`ended`. None of them is that. It was calling the gap `needs_input`, which is
the one word on the map that means *you*, specifically, are being waited for
(see [[a-turn-that-launched-an-agent-reads-as-needs-input]] for what that cost).

## What was considered

**A fifth `SessionStatus`.** `waiting_for_agent` alongside the four. Honest, and
the wrong shape: `SessionStatus` is not a vocabulary, it is a visual system.
Each value carries a size tier (`map/layout.ts`), a tick ring, a core
treatment, an arc, a blink period and a column in the map's counts, and every
one of those is drawn from a table keyed by the four
(`PLANET_TABLE`, `PLANET_TICK_LAYERS`, `statusCounts`). A fifth value forces a
fifth answer to each — five artboards that do not exist — to express a session
that should look exactly like a working one, because it is one.

**Nothing at all; let the moons say it.** A planet with moons in orbit is
already visibly busy with agents. True, but it does not separate the two cases
that matter: a session running its own turn *with* agents out, and a session
whose only remaining work is theirs. The first will answer by itself soon; the
second is as far along as it is going to get until an agent lands.

## The decision

`working`, with a modifier on the label — the same shape `interruptedAt`
already has, where a session really is `needs_input` and the chip reads
INTERRUPTED to say why.

- The server exposes `awaitingSubagents` on `ApiSession`: true only while the
  session's own turn is over *and* something it launched is still running.
  `Runner` is the only thing that can compute it — it alone sees the main
  loop's turn boundaries — and it reads liveness back out of the same
  `SubagentStore` its task events feed, so the flag and the moons can never
  disagree.
- Both readouts say `WAITING FOR AGENT` (`WAITING FOR AGENTS` past one): the
  planet's state pill and the detail panel's status chip, through one shared
  `awaitingSubagentLabel`. The count comes off the drawn moons rather than the
  flag, so the number on the pill is the number in orbit.
- Everything else about the planet is a working planet's: the size tier, the
  glow, the blinking dot on the chip. Work IS happening. It is happening in the
  moons, and the label is what says so.

## What this buys

The map's four states keep meaning what they draw, `needs_input` keeps meaning
"you", and the idle timer — which is armed off `needs_input` — stops counting
down on sessions that are mid-flight.

## The same question again: a turn that merely ended

`needs_input` covers two situations the CLI cannot separate for us, because it
parks on stdin for both: it asked something and is blocked on the answer, or it
finished its turn and the next move is yours. Only the first is anyone being
waited for, and a map whose whole job is "what needs me" was calling both of
them NEEDS INPUT.

The signal is already there — `pendingDecision`, the parked `canUseTool` — and
the ruling is the same as above, for the same reason: the status stays
`needs_input` (same size tier, same treatment, same desktop notification), and
only the word changes. `parkedLabel` returns NEEDS INPUT when something is
parked and **DONE** when the turn merely finished.

All four readouts share it, or the map goes back to contradicting itself: the
planet's pill, the panel's status chip, the sidebar row's status column, and
the map's aggregate line — which splits its `needs_input` column into
`N NEEDS INPUT · M DONE` rather than filing every finished turn under the word
that means *you*.

DONE rather than ENDED: `ended` already means the session itself is over, and
this one is alive and can be written to.

One thing had to move on the server for it. `decision_pending` and
`decision_resolved` go to `session:<id>`, which only a client with that session
SELECTED is listening to — and the map, where nothing is selected, needs the
answer too. So `Runner` announces both edges of a park through `onDecision`,
and the snapshot carrying `pendingDecision` is republished on each.

### What was NOT done

Mapping a finished turn to `idle`, which is what the CLI itself reports for a
terminal session sitting at an empty prompt (`registry.ts`: `waiting` →
`needs_input`, `idle` → `idle`) — and so the state the very same situation
already shows under when Orbital did not start it. It is the tidier model and
it would close that asymmetry, but `idle` costs the planet its size tier
(`IDLE_SCALE`, 0.71) and its desktop notification the moment a turn lands,
which is exactly when a finished session is the thing you most want to see.
Tomin's call: keep the state, change the word. The asymmetry stands.
