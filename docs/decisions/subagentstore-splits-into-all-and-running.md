---
id: subagentstore-splits-into-all-and-running
title: SubagentStore.get() splits into all() and running(), because a moon and hasLiveSubagents want different answers
type: adr
status: in-force
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
  - subagent-liveness-from-sdk-task-events
  - dismissal-marks-the-agent-only-the-map-reads-it
tags:
  - server
  - subagents
---

# `SubagentStore.get()` splits into `all()` and `running()`, because a moon and `hasLiveSubagents` want different answers

## The problem

Before this branch, `SubagentStore.get(sessionId)` returned only still-running
agents, and that one method answered two questions at once: "should this
session's status stay `working`" (`hasLiveSubagents` in `server/src/index.ts`)
and "which subagents does the map draw" (`toApiSession` and the `sessions`
topic). Both questions agreed as long as an ended agent's moon disappeared
the instant it finished. This branch makes that no longer true — an ended
moon has to stay until the user dismisses it (spec § "Moons outlive their
agents") — so the one method now needs to give two different answers.

## What was decided

`SubagentStore.get()` is gone; `server/src/transcript/subagents.ts` splits it
into `running(sessionId)` and `all(sessionId)` (`subagents.ts:311` and
`:331`), backed by the same split already made on `SubagentTracker`
(`:246` and `:251`). `all()` includes ended agents; `running()` excludes
them entirely, unchanged from what `get()` used to return.

The map, the REST session shape and the WS snapshot all read `all()`.
`toApiSession` calls it at `server/src/api/shape.ts:124` — NOT at
`server/src/index.ts:66`, which an earlier version of this file cited: that
line is `publishLiveSession`'s own inline literal for a terminal session,
a second, separate call site that happens to make the same call.
`hasLiveSubagents` (`index.ts:401`) reads `running()` and must keep doing so — the class's own
doc comment names the hazard directly: *"ended agents must never leak into
it, or a session whose agents all finished would hang at `working` forever."*
Nothing enforces this at the type level; it is a convention the doc comment
records because `all()` was, by construction, the more tempting default to
reach for once it existed.

**Dismissal is keyed by `SubagentInfo.id` (the task id), not `toolUseId`.**
`SubagentStore.dismiss(sessionId, agentId)` (`subagents.ts:350`) takes the
task id specifically because `toolUseId` is optional — the SDK only sets it
from `task_started.tool_use_id`, so an agent the tracker learned about
through some other path could have none. `id`, in contrast, is never absent;
it is the task id every code path derives an agent from. The messages route
(`server/src/api/routes.ts:259-268`) still joins on `toolUseId`, because that
is the id a moon or an `Agent` tool row actually has to hand — the two routes
key on different fields of the same `SubagentInfo` on purpose, each on the
id its own caller actually possesses.

**Republish detection widened from comparing `running()` by id alone to
comparing `all()` by id+state+status+dismissed** (`sameAgents`,
`subagents.ts:406`). Comparing only `running()` would have missed exactly
the transition this branch introduces — an agent moving from `working` to
`ended` leaves `running()` (nothing to diff there) but must still trigger a
republish so the map draws the now-ended moon. `dismissed` joined the
comparison when the whole-branch review changed what dismissal does to
`all()` (see below); by the same argument, a dismissal now moves no id and
no state either.

## Amended: `all()` marks dismissed agents, it does not withhold them

The version of this decision written with the implementation had `all()`
subtract dismissed agents. That was wrong, and the whole-branch review
caught it: `all()` is also what the messages route's "do I know this agent"
check reads, and what the wire carries to the parent transcript's `OPEN →`
control — neither of which dismissal is entitled to touch (spec §§ 5, 8).
`all()` now returns every agent with `dismissed: true` set on the dismissed
ones, and `web/src/map/sceneModel.ts` is the only reader of the flag. The
reasoning is its own file: [[dismissal-marks-the-agent-only-the-map-reads-it]].

## What was rejected

**Keeping one `get()` and having `hasLiveSubagents` filter its result by
`state`.** Not implemented; the split is at the store's own read methods
instead, so every caller states which question it is asking by which method
it calls, rather than repeating a `state !== 'ended'` filter (or forgetting
to) at each call site.

**Dismissal keyed by `toolUseId`.** Would have made an agent whose
`task_started` never carried a `tool_use_id` permanently undismissable — its
moon would outlive every other agent's on the map with no way to clear it,
which is worse than the (already-documented) inert-moon case the spec
accepts for the same missing field elsewhere (§ 5).

## Consequences

- `hasLiveSubagents(sessionId) => running(sessionId).length > 0` is the one
  call site load-bearing enough that this ADR names it directly
  (`index.ts:401`); any future reader changing which method feeds it should
  read this file first.
- Line numbers in this file were re-checked against the tree at the end of
  the branch; the first version of it cited `running()`/`all()` at 292/297
  when they sat at 293/298, and named the wrong one of two `all()` call
  sites. Cite the symbol as well as the line, and expect the line to drift.
- `server/test/subagents.test.ts` asserts `all()` and `running()` together
  for exactly this reason — the bug this split prevents only shows up when
  both answers are checked at once, not either alone.
