---
id: subagent-buffer-outlives-the-agent
title: A subagent's transcript buffer dies with the session, not the agent
type: adr
status: in-force
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
  - 2026-09-24-subagent-list-design
tags:
  - server
  - transcript
  - subagents
---

# A subagent's transcript buffer dies with the session, not the agent

## Amended 2026-09-24: dismissal is gone

[[2026-09-24-subagent-list-design]] § 5 removed moon dismissal: a finished
moon leaves the map on its own, and the subagent list and the `OPEN →` row
are how a finished agent is reached. The paragraphs below about dismissal,
and the rejected option's "until the user dismisses it", describe code that
no longer exists. The decision itself is unchanged, and matters more now:
the buffer outliving the agent is what lets the list open a finished one.
The body below stays as the record.

## The problem

`SubagentTranscripts` (`server/src/transcript/subagents.ts`, commit 9c4adc0)
holds every agent's forwarded messages in memory so the panel has something
to render. Two requirements on that buffer's lifetime pull in different
directions if answered separately: a panel opened partway through a run must
be able to catch up on steps that already streamed before it opened, and a
panel must still show the final transcript, unchanged, after its agent has
finished and the moon has gone quiet.

## What was decided

The buffer's lifetime is the **session's**, not the agent's.
`SubagentTranscripts.append()` and `.get()`
(`server/src/transcript/subagents.ts:481` and `:502`) never consult
`task_started`/`task_notification` at all — nothing about the class reacts
to an agent ending. The only thing that clears an entry is `drop(sessionId)`
(`subagents.ts:507`), called from `server/src/index.ts:341` next to
`SubagentStore.drop(sessionId)` when the session itself ends, not when any
one agent does.

This single lifetime answers both requirements for free: a panel opened
mid-run reads whatever `append()` has already accumulated, because nothing
evicted it early; a panel on a finished agent reads the same buffer, frozen,
because nothing clears it at `task_notification` either. Capped at 2000
`ChatMessage` per agent (`MAX_SUBAGENT_MESSAGES`, `subagents.ts:442`),
evicting from the front and counting what it dropped in `droppedCount`
(`subagents.ts:493-497`) — a bound on memory per agent, orthogonal to when
the whole entry is forgotten. The same cap and the same front-eviction rule
are restated on the client (`MAX_SUBAGENT_MESSAGES` in `web/src/lib/types.ts`,
read by `applySubagentEvent`): an open panel's list grows off the WS, and
without a matching bound it would outgrow the buffer it is showing and
report a step count that buffer cannot produce. The COUNT itself is never
recomputed there — it rides the WS payload, from the one store that owns it.

Dismissal is not a lifetime event either, and never was: it marks an agent
for the map and leaves the buffer entirely alone
([[dismissal-marks-the-agent-only-the-map-reads-it]]). The whole-branch
review found the messages route breaking that rule by joining on a
dismissal-filtered list.

## What was rejected

**Clearing an agent's buffer at `task_notification`, or after some grace
period once it ends.** Rejected outright: the panel's entire job past that
point is showing the frozen final transcript (`COMPLETED`/`FAILED`/`STOPPED`
in the spec's state table, § 10) — clearing the buffer the moment the
badge would need to say so removes exactly the content that state exists to
show.

**Per-agent TTLs or an LRU across agents within a session.** Never
implemented and not discussed as a real option: the spec treats "an agent
that has finished stays reachable until the user dismisses it" (§ scope) as
a hard requirement, and a time- or memory-pressure-based eviction would
silently violate it for whichever agent happened to be idle longest.

## Consequences

- Memory for a session's subagent transcripts is bounded per agent (2000
  messages) but not bounded in count of agents — a session that spawns many
  agents keeps every one of their buffers until the session ends. Not
  measured against a real worst case; acceptable because the same is already
  true of `SubagentStore`'s own per-session agent list.
- `SubagentTranscripts` has no dependency on `SubagentStore` or on task
  lifecycle events at all — the two stores are wired together only at the
  API layer (`server/src/api/routes.ts`'s messages route joins on
  `toolUseId` across both) and at the shared `drop(sessionId)` call site in
  `index.ts`. A future change to how agents are tracked cannot break the
  buffer's own lifetime rule by accident, because nothing about it reads
  agent state.
- That last sentence held for the buffer and not for its READER. The
  messages route's `known` check reads `SubagentStore`, so a change to what
  the store reports — dismissal subtracting from `all()` — made a live
  buffer unreachable without touching `SubagentTranscripts` at all. The
  join across the two stores is the seam to watch, not the class.
