---
id: subagent-messages-404-vs-empty-200
title: The subagent messages route answers 404 and empty-200 differently, on purpose
type: adr
status: in-force
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
tags:
  - server
  - api
  - subagents
---

# The subagent messages route answers 404 and empty-200 differently, on purpose

## The problem

The governing spec's original wording for
`GET /api/sessions/:id/subagents/:toolUseId/messages` was plain: *"`404` when
no buffer exists for that pair"* (spec § 9). Read literally, that is also
true of an agent that has just started and has not produced a single message
yet — `SubagentTranscripts.append()` (`server/src/transcript/subagents.ts`)
only creates an entry on first append, so a brand-new agent's buffer
genuinely does not exist for a little while after `task_started`. A route
built to the letter of that sentence would 404 a panel opened on an agent
that is working normally and simply has not said anything yet — the same
response code as a server restart that actually lost the stream.

## What was decided

The route (`server/src/api/routes.ts:256-265`) tells three cases apart, not
two:

1. **Session unknown to the DB** → `404`, matching every neighbouring
   session route's own not-found behaviour.
2. **Agent unknown to `SubagentStore`** (`ctx.subagents.all(id).some((a) =>
   a.toolUseId === toolUseId)` is false) → `404`. This is the genuine "stream
   lost" case the spec's `STREAM LOST` state (§ 10) exists for: the server
   restarted and the in-memory tracker has no record of this agent at all.
3. **Agent known, but `SubagentTranscripts.get()` has no entry yet** →
   `200` with `{ messages: [], droppedCount: 0 }`. The agent is real and
   tracked; it simply has not appended anything, which is the normal state
   of a just-started agent for the first few hundred milliseconds of its
   life.

This is a correction of the spec's own prose, made during task 4's
implementation — the task-4 brief gave the corrected three-case rule
directly, and the commit that shipped it (4c66ec7) records the correction in
its own message rather than silently diverging from the spec's written
words.

## What was rejected

**404 whenever `SubagentTranscripts.get()` returns nothing**, matching the
spec's literal sentence. Rejected because it conflates two situations a
panel needs to tell apart on open: "this agent's stream is gone, render
`STREAM LOST`" and "this agent is fine and has not spoken yet, render
`RUNNING` with an empty transcript". Collapsing them into one response code
would have made every panel opened early in an agent's life flash
`STREAM LOST` before its first message arrived.

## Consequences

- A panel opened on a freshly started agent renders `RUNNING` with an empty
  body, not `STREAM LOST` — confirmed by `server/test/routes.test.ts`'s
  coverage of the known-but-no-buffer case alongside the genuinely-unknown
  one.
- The route now depends on `SubagentStore` (for "is this agent known at
  all") in addition to `SubagentTranscripts` (for "what has it said"), where
  a stricter reading of the spec would only have needed the latter. Both are
  threaded onto `RouteContext` via `ctx.subagents` and
  `ctx.subagentTranscripts`.
- Any future route that answers "does X exist yet" for something created
  lazily on first write (rather than at creation) should check this file
  before defaulting to "empty read means 404" — that default is exactly the
  literal spec reading this route rejected.
