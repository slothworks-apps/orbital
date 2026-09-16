---
id: 2026-09-16-subagents-everywhere-design
title: Subagents for every session, not only the open one
type: spec
status: done
domain: subagents
related:
  - 2026-09-15-orbital-design
  - subagents-in-transcripts
  - subagents-only-for-orbital-sessions
---

# Subagents for every session, not only the open one

## The problem

The map draws a moon for every subagent of every planet. The data behind those
moons only ever existed for one session — the selected one — so in practice
moons almost never appeared.

Three separate causes:

1. **Subagent state was bound to the selection.** The browser subscribes to
   `session:<id>` only for the selected session (`web/src/App.tsx`), and the
   server started a transcript tail only on that first subscriber. An
   unselected planet had nothing producing subagent events, ever.
2. **The tail started at EOF**, so a subagent already running when it started
   was never seen, and its later result matched no known agent.
3. **Orbital's own sessions had no subagent detection at all.** The runner
   streams every subagent call for the whole life of a web session and never
   looked at them.

Mid-build, a fourth cause turned up and changed the shape of the answer: the
subagent tool is called `Agent`, not `Task`, and a *running* subagent is not
in the transcript at all. See [[subagents-in-transcripts]] for the
measurements, and [[subagents-only-for-orbital-sessions]] for what that ruled
out.

## What was built

**Subagents ride in the session shape.** `ApiSession` carries
`subagents: SubagentInfo[]` — the ones running right now. The map gets them
for every session, and a page reload gets them from `GET /api/sessions` like
everything else. The `subagent` event on `session:<id>` is gone: one path, not
two.

**`SubagentStore`** (`server/src/transcript/subagents.ts`) holds one
`SubagentTracker` per session and is the server's single source of truth.
`feed(sessionId, entries)` returns whether the *running* set changed — callers
turn that into "republish this session" (`publishSession` in `index.ts`), so a
batch that changes nothing publishes nothing. `drop(sessionId)` forgets a
session that ended.

`toApiSession` reads it, so every REST response and every `sessions`-topic
upsert carries the current set.

**One feeder: the runner.** `Runner.onEntries` passes every `assistant`/`user`
message from the SDK stream to the store. The stream is read as it is
produced, so a subagent call arrives when the model emits it — before the
subagent runs. Nothing is read from disk, and there is no setting, because
there is no cost to weigh.

**Terminal sessions report no subagents.** Not a gap to fill later: a
transcript cannot answer the question at all.

## Deliberately absent

- No live-transcript watcher, and no `watch_live_subagents` setting. Both were
  built, then removed once the measurements showed they could only ever report
  "none running". [[subagents-only-for-orbital-sessions]] has the reasoning.
- No persistence. Subagent state is in memory and dies with the process, which
  is correct: nothing in it outlives the SDK stream that produced it.
- Subagents carry `id`, `name` and `state` only — no nested transcript, no
  usage, no `materializing`/`needs_input` refinement of the state vocabulary.

## Tests

`server/test/subagentsEndToEnd.test.ts` is the one that matters: a real
`buildServer` with a fake SDK that starts a subagent, parks, and finishes it
on release — asserting the subagent is visible over REST while it runs, with
nothing selected and nothing tailed, and gone once it reports back.
