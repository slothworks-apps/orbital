---
id: dismissal-marks-the-agent-only-the-map-reads-it
title: Dismissal marks an agent and only the map reads the mark
type: adr
status: superseded
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
  - subagentstore-splits-into-all-and-running
  - subagent-buffer-outlives-the-agent
  - subagent-messages-404-vs-empty-200
  - 2026-09-24-subagent-list-design
tags:
  - server
  - web
  - subagents
  - map
---

# Dismissal marks an agent and only the map reads the mark

## Superseded

2026-09-24: [[2026-09-24-subagent-list-design]] § 5 has finished moons leave
the map on their own when their agent ends, so there is nothing left to
dismiss. Dismissal was removed in full — not left dead — including the mark
this ADR is about. The body stays as the record of the bug and the decision.

## The problem

Dismissing a moon was implemented as a subtraction:
`SubagentStore.all(sessionId)` filtered out every id in the session's
dismissal set. One line, and it read as obviously right — `all()` is "what
the map should show", the map should stop showing this, done.

`all()` is not that. Five readers sit on it — three server/wire-adjacent ones
named below, plus two client readers of the resulting `session.subagents`
this document did not originally count — and dismissal is about exactly one
of them:

1. `web/src/map/sceneModel.ts` draws a moon per entry. **Dismissal's actual
   target.**
2. `web/src/panels/Transcript.tsx` hands the same list to `ToolRow`, which
   joins each `Agent`/`Task` row on `toolUseId` to decide whether it gets an
   `OPEN →` control.
3. `server/src/api/routes.ts`'s messages route asks `all()` whether it knows
   the agent at all, and 404s if not.
4. `web/src/panels/DetailPanel.tsx:157` reads `session.subagents` into the
   `aria-label="Subagents"` chip strip (`:916-923`). It does not filter on
   `dismissed`, so a dismissed agent's chip keeps showing there. That strip
   never dropped `ended` agents either, and the instruction this ADR is named
   for is "dismissal must govern the map only" — so a dismissed agent still
   showing here is that instruction working as specified, not a defect.
5. `web/src/lib/types.ts:337` `awaitingSubagentCount`, read by
   `web/src/map/Planet.tsx:1024` and `web/src/panels/DetailPanel.tsx:817`. It
   filters `state !== 'ended'` (`:341`) but not `dismissed`, so a dismissed
   `ended` agent is already excluded by the state filter alone, while a
   dismissed agent still `working` would be counted. That second case is not
   a live hazard: the UI only offers the dismiss control once
   `state === 'ended'`, so reaching it requires calling
   `POST /api/sessions/:id/subagents/:agentId/dismiss` directly rather than
   through any control this app renders. Recorded as the known edge it is,
   not filed as a bug.

So dismissing a moon also deleted the parent transcript's way back into that
agent's transcript, and 404'd the REST route behind it — which the panel
renders as `StreamLostBody`: *"The Orbital server lost this agent's buffer —
most likely a restart."* The buffer had not moved. `SubagentTranscripts` is
untouched by dismissal and always has been
([[subagent-buffer-outlives-the-agent]]); the data was sitting in memory
with every route to it closed and an error message blaming a restart that
never happened.

The spec says the opposite twice, in as many words:

> § 5: "Unlike the moon this is part of the record forever … still reachable
> after scrolling back through a long session — **and after the moon has
> been dismissed**."

> § 8: "Moon dismissed | That moon leaves the map; **the row's `OPEN →`
> still works**"

Each of the nine implementation tasks passed its own review. This was only
visible from outside all of them, because each seam is correct in isolation:
`all()` subtracting is defensible if `all()` means what its caller in front
of you assumes, and the messages route joining on `all()` is defensible if
`all()` means "every agent that exists".

## What was decided

**Dismissal is a MARK on the agent, and `web/src/map/sceneModel.ts` is the
only code in either workspace entitled to act on it.**

- `SubagentInfo` gains `dismissed?: boolean`
  (`server/src/transcript/subagents.ts`). `SubagentTracker` never sets it —
  the tracker stays a pure record of what the SDK said happened.
  `SubagentStore.all()` applies it, on a copy (`{ ...a, dismissed: true }`),
  as it reads the dismissal set held beside the trackers.
- `toApiSession` carries the list unchanged, so the flag rides the same wire
  the agents already do and a page reload learns it from
  `GET /api/sessions` like everything else.
- `buildSceneModel` filters `!a.dismissed` when it builds moons. That filter
  is now the complete definition of what dismissing does.
- `sameAgents` — the before/after diff every subagent mutation goes through
  to decide whether to republish — compares `dismissed` too. Without that
  the republish would stop firing: marking changes no id, no state, no
  status and not the list's length, so the map would never learn the moon
  had gone.
- The messages route needs no change at all once `all()` stops subtracting.
  Its `known` check answers "yes" for a dismissed agent, which is the truth.

## What was rejected

**Joining the messages route on the tracker directly, leaving `all()` as a
filter.** This was the review brief's other suggestion and it is smaller —
one accessor. It fixes the 404 and only the 404. The `OPEN →` control is
rendered from the list on the wire, and `openSubagent(sessionId, subagent)`
needs a real `Subagent` (its `state`, `status` and `startedAt` drive the
whole header), so the client has to be *told* about a dismissed agent
whatever the server route does. Once the wire carries it, `all()` is no
longer filtering anything the client cannot see, and keeping the server-side
filter as well would leave two different answers to "which agents are
there", which is the shape of the original bug.

**A second field on `ApiSession` — `subagents` plus `dismissedSubagentIds`.**
Same information, spread across two places that can disagree, and every
reader would have to remember to cross-reference. The flag travels with the
thing it is about.

**Filtering in `useSceneModel` or in `Moon` instead of `buildSceneModel`.**
`buildSceneModel` is pure and already the single derivation of what the map
draws; a filter further down would have to be repeated for the planet's own
`subagents` (which sets its footprint and orbit spacing).

## Consequences

- `Subagent.dismissed` is a flag with exactly one legitimate reader, and
  nothing enforces that. Both its declarations — `SubagentInfo` on the
  server, `Subagent` in `web/src/lib/types.ts` — say so in their doc
  comments, because the tempting thing to do with a boolean on a list is to
  filter by it.
- `all()` now means "every agent this session has ever had", which is a
  plainer contract than "every agent minus a UI preference" and harder to
  misread at a call site.
- A dismissed agent's buffer stays in memory until the session ends, exactly
  as before — dismissal never freed anything, it only appeared to.
- `server/test/routes.test.ts` pins the regression directly: the messages
  route still answers 200 with the buffer AFTER the moon is dismissed.
