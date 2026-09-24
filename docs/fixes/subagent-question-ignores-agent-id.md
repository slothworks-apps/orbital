---
id: subagent-question-ignores-agent-id
title: decide() cannot tell a subagent's AskUserQuestion from the parent's own
status: done
type: fix
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
  - subagent-liveness-from-sdk-task-events
  - a-subagents-question-is-refused-not-relayed
tags:
  - server
  - runner
  - subagents
---

# decide() cannot tell a subagent's AskUserQuestion from the parent's own

Found during the review of the subagent transcript panel (task 7 of
`2026-09-22-subagent-transcript-panel-design`). Not fixed there: it is a
server-side gap the panel had to design AROUND (see "What the panel does
about it" below), and closing it is a change to `decide()`'s own contract —
out of scope for a task whose brief explicitly said "No server changes."

## What the gap is

`Runner.decide()` (`server/src/runner/runner.ts`) is the SDK's `canUseTool`
callback. It branches on the tool name only:

```ts
private decide(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  opts: Parameters<CanUseTool>[2],
): Promise<PermissionResult> {
  if (toolName !== QUESTION_TOOL) {
    return Promise.resolve({ behavior: 'deny', message: `Orbital has no prompt surface for ${toolName}.` });
  }
  // ...
  const pending: PendingDecision = {
    id: opts.toolUseID, kind: 'question', input, createdAt: Date.now(),
  };
  // ...
  this.hub.publish(`session:${sessionId}`, { event: 'decision_pending', decision: pending });
```

Every `AskUserQuestion` call reaching `canUseTool` — whatever produced it —
is treated identically: parked, published as `decision_pending` on the
PARENT session's own `session:<id>` topic, keyed by `opts.toolUseID`.

The SDK's own options type, on the exact object `decide()` receives
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:278`), carries the
field that exists to prevent this:

```ts
/** If running within the context of a sub-agent, the sub-agent's ID. */
agentID?: string;
```

`decide()` never reads it.

## What it would cause

If a subagent's own toolset ever includes `AskUserQuestion` and it calls it,
`canUseTool` fires for that call too (subagent tool permission still routes
through the host's callback — the subagent has no `canUseTool` of its own).
`decide()` parks it exactly like a top-level question: `pendingDecisions`
gets an entry keyed by the SESSION id, with `id` equal to the SUBAGENT's own
`toolUseId`.

Nothing about that entry says "this came from three levels of Task nesting
down," and the parent's own transcript never shows a row for it either — the
tool_use block is a subagent frame, routed to that agent's own buffer, never
to `session:<id>` (spec `2026-09-22-subagent-transcript-panel-design.md` §
2). So the one surface that ever renders this specific `AskUserQuestion` is
the subagent transcript panel, via `forwardSubagentText` mirroring it into
that agent's buffer — and without the panel's own guard (see below), that
surface would render it as a normal, answerable card, with the composer of
the (unrelated-looking) parent session ALSO technically able to answer the
same decision id through its own `pendingDecisions[sessionId]`-driven flow.
Two write paths to the one promise `decide()` is holding open, neither of
which is visibly "the subagent's own question" to whoever is looking at it.

## What the panel does about it

It does not rely on `agentID` existing to tell the two cases apart, because
today it does not. `TranscriptView` gained a `readOnly` prop, threaded to
`QuestionCard`, which forces every question card in the subagent panel into
its `answered`/`locked` forms regardless of what `pendingDecisions` says —
built so the panel is read-only BY CONSTRUCTION, not by an inference about
which ids can or cannot collide. `web/src/test/subagentpanel.test.tsx`
("stays non-interactive even when pendingDecisions DOES match the question")
seeds a `pendingDecisions` entry that DOES match the mirrored tool_use's id
and asserts the card still renders non-interactively — the scenario this
document describes, reproduced directly.

## Why it is out of scope here

Reading `opts.agentID` and branching `decide()` on it is a change to how the
server handles a subagent's own permission requests generally — it is not
specific to the read-only panel, and the right behaviour once `agentID` is
read (deny outright? route it somewhere new? surface it as its own kind of
`PendingDecision`?) is a design question the governing spec never asked,
because `AskUserQuestion` inside a subagent's own toolset was not part of
its scope. Worth revisiting if a subagent build ever actually reaches for
that tool — nothing observed on this machine has yet.

## Fixed 2026-09-24

`decide()` reads `opts.agentID`. A question from inside a subagent is denied
with a message telling the model to ask from the parent session, and nothing
is parked or superseded. A subagent's permission ask keeps its old path: the
parent's card answers it. The choice is recorded in
[[a-subagents-question-is-refused-not-relayed]]. Tests: "refuses a
subagent's question and parks nothing, not even over the parent's own" and
"still parks a subagent's permission ask on the parent session" in
`server/test/runner.test.ts`.
