---
id: the-open-time-snapshot-reverts-a-completed-panel-to-running
title: The panel's open-time snapshot reverts a completed agent to RUNNING once its session's tracker is dropped
type: fix
status: done
domain: subagents
related:
  - the-panel-reads-its-agent-live-not-the-snapshot-it-opened-with
  - reconnect-reopens-the-open-subagent-panel
  - 2026-09-22-subagent-transcript-panel-design
tags:
  - web
  - store
  - subagents
---

# The panel's open-time snapshot reverts a completed agent to RUNNING once its session's tracker is dropped

Found by the review that landed C1 itself (`fix(subagents): close the
whole-branch review`, `385e7bc`), reproduced in a temp copy through the real
`openSubagent` path rather than a seeded fixture. Filed rather than fixed in
the same pass: C1's fallback was prescribed by the fix brief, so closing this
is a design change to that fallback, not a slip in implementing it.

## What actually happens

`SubagentPanel` reads its agent live out of the store and falls back to the
snapshot `openSubagent` captured when the panel opened
([[the-panel-reads-its-agent-live-not-the-snapshot-it-opened-with]]):

```ts
const liveSubagent = useOrbital((s) =>
  panel ? s.sessions[panel.sessionId]?.subagents.find((a) => a.id === panel.subagent.id) : undefined
)
const subagent = panel ? (liveSubagent ?? panel.subagent) : null
```

(`web/src/panels/SubagentPanel.tsx:157-160`)

The fallback assumes the live lookup only ever misses when the whole session
is gone (reconnect, restart) — cases already caught by `panel.found` and
rendered as STREAM LOST. It misses a case where the SESSION is very much
still known but its subagent LIST has gone empty out from under the panel:

1. Panel opened on a RUNNING agent (`panel.subagent.state === 'working'`).
   The agent ends. `applySessionsEvent` lands the new `state: 'ended'` on a
   fresh object, the live read picks it up, and the badge correctly shows
   `completed` with the elapsed clock frozen.
2. The PARENT session ends. `onStatus` in `server/src/index.ts:325` calls
   `subagents.drop(sessionId)` — `SubagentStore.all(sessionId)` returns `[]`
   for that session from this point on, unconditionally
   (`server/src/transcript/subagents.ts`, `drop()`).
3. Nothing has re-published `sessions` yet, so `sessions[sessionId].subagents`
   in the store still holds the array from step 1 and the panel still reads
   `completed` correctly. But the NEXT republish of that session carries
   `subagents: []`, because it re-derives from `SubagentStore.all()`, which is
   now empty. Confirmed publishers of `sessions` for an already-ended session:
   - a pin, `PUT /api/sessions/:id/pinned` (`server/src/api/routes.ts:602`)
   - a map-dismiss, `PUT /api/sessions/:id/dismissed`
     (`server/src/api/routes.ts:576`)
   - a model change, `POST /api/sessions/:id/model`
     (`server/src/api/routes.ts:711`)
   - an auto-title landing after `SessionTitler`'s `finish()`
     (`republish(sessionId)` in `server/src/index.ts:298`)

   (A plain tag edit does *not* trigger this — `PUT /api/sessions/:id/tags`
   only writes `sessionTags` and calls `regenerateRuleTags`, neither of which
   publishes to the `sessions` topic. Worth knowing if this list is used to
   write a regression test: a tag change is not a reachable trigger today.)
4. `liveSubagent` now misses (`find` over `[]`), and the panel falls back to
   `panel.subagent` — the object `openSubagent` captured in step 1, which
   still holds `state: 'working'`. The header reverts: `data-task-state`
   (`web/src/ui/Badge.tsx:250`) flips back to `"running"`, the blinking dot
   returns, and `elapsedMsFor` starts measuring against `nowMs` again because
   `taskStateFor` now reads `'running'` — the elapsed ticker **restarts** on
   an agent that already finished. Reproduced output: `SUBAGENT · READ-ONLY …
   RUNNING 3m 0s` for an agent that had reported `completed` minutes earlier.

`panel.found` does not save this. It is only ever set to `false` by
`openSubagent`'s own 404 branch, and none of the four republish paths above
call that — they all publish a 200 `upsert` for a session the server still
knows perfectly well. The reconnect path is not this bug: a reconnect re-runs
`openSubagent` (`resyncAfterReconnect`), which refetches
`/api/sessions/:id/subagents/:toolUseId/messages`, gets a 404 because
`SubagentStore.all()` is empty (`server/src/api/routes.ts:263-264`), and
renders honest STREAM LOST. This hole is reachable without any reconnect at
all.

## Severity and history

**Not a regression.** Before C1, the panel showed RUNNING unconditionally,
for the whole time it was open, on every agent. C1 shrinks the reachable
surface from "always" to "only after the parent session's tracker is
dropped AND something republishes that session" — a strict improvement, with
a narrower hole left where a wider one used to be.

**The fallback itself was prescribed**, not improvised: C1's own brief called
for "live read, snapshot as fallback," and the fallback's whole reason to
exist is the window between "session reloaded" and "session's agents
repopulated," which the ADR names correctly. This case is a second, unnamed
window the ADR's reasoning did not anticipate: the tracker being dropped
*permanently* rather than transiently reloaded, so nothing ever repopulates
`sessions[id].subagents` for that session again.

## Where to start

Keep the LAST KNOWN LIVE agent instead of the agent captured at open time.
Concretely: only replace the stored fallback while `liveSubagent` actually
resolves (i.e. write the live value back into `panel.subagent`, or hold a
separate `lastKnownLive` ref, whenever the find succeeds), and fall back to
*that* rather than to the immutable open-time snapshot when the live read
next misses. A `state: 'ended'` fallback can only ever render `completed` /
`failed` / `stopped` — never `running` — so the header cannot un-complete
itself no matter how many empty republishes follow. This was the option the
governing ADR rejected for the ORIGINAL bug (a second writer to
`subagentPanel.subagent`) for a different, still-valid reason — the identity
guards in `openSubagent`'s async continuations key off that reference being
set exactly once by the open action itself. Whatever lands here needs its own
field, not a second writer to that one.

## Fixed 2026-09-24

`SubagentPanel` keeps a `lastKnownLive` ref, written whenever the live lookup
resolves for the open agent, and falls back to it before the open-time
snapshot. The snapshot now only answers for an agent the live lookup never
found. `subagentPanel.subagent` still has one writer. Test: "stays completed
when a later republish carries no agents at all" in
`web/src/test/subagentpanel.test.tsx`.
