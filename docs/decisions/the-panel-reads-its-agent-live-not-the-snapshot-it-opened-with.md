---
id: the-panel-reads-its-agent-live-not-the-snapshot-it-opened-with
title: The subagent panel re-reads its agent from the session, not from the snapshot it opened with
type: adr
status: in-force
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
  - subagent-panel-close-watches-selectedid
  - reconnect-reopens-the-open-subagent-panel
tags:
  - web
  - subagents
  - store
---

# The subagent panel re-reads its agent from the session, not from the snapshot it opened with

## The problem

`openSubagent(sessionId, subagent)` stored the `Subagent` **by value, once**:

```ts
set({ subagentPanel: { sessionId, subagent, messages: [], droppedCount: 0, found: true } })
```

Every later write to the slice spreads `...current` and never replaces
`subagent`. Nothing anywhere writes `subagentPanel.subagent` again.

Meanwhile `applySessionsEvent` replaces `sessions[id]` **wholesale** from the
WS payload — that is how the map learns a moon went grey — so the live
`state` and `status` land on brand new `Subagent` objects that the panel does
not hold and has no path to.

`SubagentPanel` read `panel.subagent` for both of the things that matter:
`taskStateFor(...)` (the badge, and whether the elapsed clock ticks) and the
`state === 'ended'` gate on the "dismiss moon" control. So:

1. Click a running moon. Panel opens, RUNNING, elapsed ticking.
2. The agent reports back. `task_notification` → the server republishes →
   the moon redraws in ended greys.
3. The panel keeps saying RUNNING, with its blinking dot. `elapsedMsFor`
   keeps returning `now - startedAt`, so the clock runs forever. The dismiss
   control never appears.

Spec § 8's lifecycle row — "Agent ends | Panel stays, frozen, with the final
report" — and the whole COMPLETED/FAILED/STOPPED half of § 10 were
unreachable on the only path that produces them. They were reachable only by
opening a panel on an ALREADY-ended agent, which is what every test in the
branch seeded, and which is why nine per-task reviews all passed.

## What was decided

**The panel selects the live agent out of the store on every render**, and
keeps the stored snapshot only as a fallback:

```ts
const liveSubagent = useOrbital((s) =>
  panel ? s.sessions[panel.sessionId]?.subagents.find((a) => a.id === panel.subagent.id) : undefined
)
const subagent = panel ? (liveSubagent ?? panel.subagent) : null
```

Joined on `subagent.id` — the task id, the one field `SubagentInfo` always
carries — not on `toolUseId`, which the SDK makes optional.

Everything the panel derives from the agent reads `subagent`, including the
two hook-safe values above the early return (`panelKey`, `runningWhileOpen`),
so the elapsed ticker stops on the same render the badge changes.

The selector returns an element of the array, not a new object, so its result
is reference-stable between store updates and zustand's default `Object.is`
comparison is correct for it — the trap named at length further down
`store.ts` for `visibleSessions`/`statusCounts` does not apply here.

**The fallback is not STREAM LOST.** A session that no longer carries the
agent — a restarted server repopulates `sessions` with `subagents: []` —
keeps its header naming the agent the user opened rather than blanking.
What turns that into STREAM LOST is `panel.found`, written by
`openSubagent`'s own 404 branch, which the reconnect now re-runs
([[reconnect-reopens-the-open-subagent-panel]]).

This is safe for `panel.found`, which the fallback is scoped to, but it is
not safe for `panel.subagent`'s STATE more generally: a live session whose
`SubagentStore` has been dropped (the parent session ended) and then
republished for an unrelated reason — a pin, a map-dismiss, a model change,
an auto-title landing — carries `subagents: []` too, `panel.found` stays
`true` because there was no 404, and the fallback reverts an already-`ended`
agent to the `working` snapshot it opened on: badge, blinking dot and
elapsed ticker all un-complete. See
[[the-open-time-snapshot-reverts-a-completed-panel-to-running]] for the
reachable path and why this decision's fallback does not close it.

## What was rejected

**Updating `subagentPanel.subagent` from `applySessionsEvent`.** Would work,
and would put the fix at the source of the staleness. Rejected because it
adds a second writer to a slice whose whole identity discipline — every
async continuation in `openSubagent` re-checks `current.subagent === subagent`
to tell a stale response from a fresh one — depends on that reference being
set exactly once, by the action that opened the panel. Deriving in the
component leaves the identity check intact and needs no new invariant.

**Storing only `{ sessionId, agentId }` and looking the agent up everywhere.**
Cleaner in principle, but it removes the fallback: the panel would render
nothing at all during the window where the session has been reloaded without
its agents, which is precisely the window the user most needs to be told
something about.

## Consequences

- `subagentPanel.subagent` is now the panel's *opening* snapshot and its
  fallback, not its current state. It is still what the identity guards
  compare, and still what `resyncAfterReconnect` re-opens with.
- The panel is one store read closer to the map: a change the map draws and
  a change the panel draws now come from the same object on the same event.
- `web/src/test/subagentpanel.test.tsx` drives the TRANSITION — open on a
  running agent, deliver a `sessions` upsert that ends it — which is the
  lifecycle test spec § 11 asked for ("freeze on `task_notification`") and
  which no seeded-fixture test can stand in for.
- Amended 2026-09-24: the open-time snapshot is no longer the first
  fallback. `SubagentPanel` keeps a `lastKnownLive` ref, written on every
  render where the live lookup resolves, and falls back to it before
  `panel.subagent`. An ended agent therefore stays ended when a later
  republish of its session carries `subagents: []`
  ([[the-open-time-snapshot-reverts-a-completed-panel-to-running]]). It is
  the component's own ref, not a second writer to `subagentPanel.subagent`,
  for the reason under "What was rejected". The snapshot still answers for
  an agent the live lookup never resolved, such as the server-restart case
  above.
