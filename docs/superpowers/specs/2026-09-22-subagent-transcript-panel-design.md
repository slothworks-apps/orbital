---
id: 2026-09-22-subagent-transcript-panel-design
title: Subagent transcript panel
type: spec
status: draft
domain: subagents
related:
  - 2026-09-16-subagents-everywhere-design
  - subagents-in-transcripts
  - subagent-liveness-from-sdk-task-events
  - 2026-09-18-transcript-folding-design
  - 2026-09-21-fit-honours-the-panels-design
---

# Subagent transcript panel

## The problem

A moon on the map says a subagent is running and nothing else. What it is
doing — which files it read, which commands it ran, what it is about to
report back — is invisible until it finishes and the parent summarises it in
one line. The interesting window is exactly the one that is closed.

Orbital runs `Agent` in the background, so the parent keeps working while the
agent does. Watching the two side by side is the point: the moment worth
seeing is the agent returning and the parent reacting to it.

### Scope

**Orbital's own sessions only.** Moons exist only for sessions the Runner
owns — `onTaskEvent` in `server/src/index.ts` is, as its comment says, "the
one feeder", and it is fed solely by the SDK stream. Terminal sessions get
`subagents: []` and therefore no moons. They are out of scope by decision:
the CLI has its own subagent viewer.

**Live, not archival.** The panel shows an agent from the moment it is opened
onward, and freezes when the agent ends. There is no browser for past
subagents and no pagination.

**Read-only.** Writing to a subagent was considered and dropped. The SDK
exposes no host-side channel to a running task — `Query` has no such control
request — so a "message the agent" feature would have had to inject an
instruction into the *parent* session asking it to relay via `SendMessage`.
That costs a parent turn, can derail the parent's work, and is not the thing
it would appear to be. The panel has no composer.

## What already holds

Measured against Claude Code 2.1.236 / `@anthropic-ai/claude-agent-sdk`
0.3.272 on 2026-09-22.

- `forwardSubagentText` is an SDK `query()` option built for exactly this:
  "When true, the full subagent conversation is forwarded so consumers can
  render a nested transcript." Without it, only `tool_use`/`tool_result`
  blocks from subagents are emitted.
- Subagent frames carry `parent_tool_use_id` set to the `Agent` `tool_use`
  that started them. `SubagentInfo.toolUseId` already carries the same id
  from `task_started`, so the moon-to-transcript join needs no new key.
- Subagent transcripts also exist on disk under
  `<session-id>/subagents/agent-<agentId>.jsonl`, written incrementally
  (file birthtime matches the first entry's timestamp, mtime the last, across
  all 15 files measured in one project). This spec does **not** read them:
  the stream gives the same content without a watcher or a meta-file join.
  It is recorded here because it is the fallback if `forwardSubagentText`
  ever stops being honoured.

## The bug this uncovers

`pump()` (`server/src/runner/runner.ts`) publishes every `assistant`/`user`
frame to `session:<id>`:

```js
this.onEntries?.(sessionId, [msg as TranscriptEntry]);
for (const chat of sdkToChatMessages(msg, () => ++this.seq, this.images)) {
  this.hub.publish(topic, { event: 'message', message: chat });
}
```

Subagent frames are deliberately excluded from the status edge and from the
context reading just above (both guard on `msg.parent_tool_use_id == null`),
but not from the publish. Since the SDK forwards subagent `tool_use` /
`tool_result` blocks by default, **a subagent's tool calls already appear in
the parent's live transcript**, indistinguishable from the parent's own. On
reload they vanish: `entriesToMessages` skips `isSidechain` entries
(`server/src/transcript/parser.ts`). Live and reloaded transcripts of the
same session disagree today.

The routing in § 2 closes this. It is not optional cleanup — turning on
`forwardSubagentText` without it would flood the parent with the whole
subagent conversation.

## 1. Turn the forwarding on

`forwardSubagentText: true` joins the options object in `Runner.start()`
(`server/src/runner/runner.ts`).

An older CLI that does not honour the flag ignores it silently: only tool
blocks arrive, and the panel renders tool rows with no text or thinking.
That is the accepted degradation — nothing errors.

## 2. Route frames by `parent_tool_use_id`

At the publish site in `pump()`, a frame branches:

- `parent_tool_use_id == null` — the parent's own. Published to
  `session:<id>` and passed to `onEntries`, exactly as today.
- `parent_tool_use_id` set — a subagent's. Appended to that subagent's
  buffer (§ 3) and published to `subagent:<sessionId>:<toolUseId>`. It does
  **not** reach `session:<id>` and does not reach `onEntries`.

Nested agents need no special handling. An agent spawned by an agent carries
the *inner* `Agent` tool_use id, so it lands in its own buffer, and the outer
agent's buffer sees only the `tool_use` block — a tool row like any other.
Depth-2 agents have no moon and so cannot be opened; nothing is lost, there
is simply no way in yet.

## 3. `SubagentTranscripts`

A new store beside `SubagentStore` in `server/src/transcript/subagents.ts`,
with the same lifetime.

- Key: `sessionId` + `parent_tool_use_id`. Value: a ring buffer of
  `ChatMessage`.
- **The buffer outlives the agent, not the session.** `task_notification`
  retires the moon; the buffer stays until `drop(sessionId)`. Both open
  questions this design has — catching up a panel opened mid-run, and having
  something to freeze when the agent ends — are the same buffer.
- Cap of 2000 `ChatMessage` per agent — comfortably above any agent run
  measured so far (the largest subagent transcript on this machine is ~100 kB
  / a few hundred entries), low enough that a runaway agent cannot grow the
  server without bound. On eviction the buffer records that it dropped
  history, so the panel can mark it (§ 6). A silently truncated record reads
  as a complete one.

## 4. API surface

- `GET /api/sessions/:id/subagents/:toolUseId/messages` → the buffer, as
  `ChatMessage[]`, the shape the transcript renderer already consumes.
  `404` when no buffer exists for that pair.
- WS topic `subagent:<sessionId>:<toolUseId>` → `{ event: 'message',
  message }` increments, mirroring `session:<id>`.

## 5. `SubagentInfo` gains two fields

- `startedAt` (epoch ms, stamped on `task_started`) — the panel header shows
  elapsed time, which is the headline number for a thing you are watching
  run.
- `status` — the terminal status from `task_notification`. The tracker today
  treats `completed`, `failed` and `stopped` identically ("Any status ends
  the moon"), which is right for the moon and wrong for a frozen panel: which
  of the three happened is the first thing a reader wants.

The model needs no field: assistant frames carry `message.model`, which
`ChatMessage` already transports.

## 6. The panel

### Extraction first

`web/src/panels/Transcript.tsx` couples three things: store wiring, scroll
and windowing management, and rendering. The rendering and scroll halves are
generic over a message array.

- New `TranscriptView({ messages, isWorking, ... })` — pairing, windowing,
  tool-run folding, model dividers, scroll anchoring.
- `Transcript` becomes a thin wrapper supplying the store's slices, the
  session error states and "load older".
- "Load older" is optional on `TranscriptView`. A subagent buffer is finite
  and unpaginated, so the subagent panel omits it.

**The extraction is behaviour-preserving by definition:** if
`web/src/test/transcript.test.tsx` or `transcriptmotion.test.ts` need edits,
it was a rewrite, not an extraction.

### Anatomy

Header: the agent's `description` from `task_started`, a chip with its
`subagent_type`, a state badge (running / completed / failed / stopped),
its model, and elapsed time. Body: `TranscriptView`. No composer, no footer.

### Layout

The panel slides in at the right edge and pushes the detail panel left.

- Default 380 px, minimum 320 px.
- The two panels together are capped at 75 % of the viewport.
- **The detail panel yields first**, down to its existing 360 px minimum. The
  reader opened the agent; the parent is the one that gives way.

### Lifecycle

| Event | Result |
|---|---|
| Click a moon | Panel opens on that agent |
| Click another moon | Content switches; one slot, panels do not stack |
| Agent ends | Moon goes out; panel stays, frozen, with the final report |
| Detail panel closes | Subagent panel closes with it |
| Another planet selected | Subagent panel closes — it belonged to the old session |

A moon whose `SubagentInfo` has no `toolUseId` is not clickable.
`task_started.tool_use_id` is optional in the SDK, and an unjoinable moon is
better left inert than given a second matching mechanism for an edge case.

## 7. Error states

- **Server restart, or `drop()` under an open panel.** The buffer is memory
  only. The panel must say the stream was lost, not render empty — an empty
  transcript reads as "the agent did nothing", which is false.
- **Buffer cap reached.** A marker at the top of the transcript naming the
  dropped history.
- **Agent failed or was stopped.** Carried by § 5's `status` into the header
  badge.
- **CLI without `forwardSubagentText`.** Tool rows, no text. No error.

## 8. Testing

Server (70 tests today):

- `pump()` routing against a fake stream with mixed `parent_tool_use_id`,
  following the existing fake-stream pattern used for task events.
- Regression for the § "The bug this uncovers": a stream carrying a subagent
  `tool_use` publishes nothing on `session:<id>`.
- Buffer: eviction at the cap, and `drop()` at session end.
- `startedAt` and `status` populated from the task events.

Web (352 tests today):

- `transcript.test.tsx` and `transcriptmotion.test.ts` pass **unedited**.
- Panel lifecycle: open, switch, close-with-parent, close-on-reselect, and
  the freeze on `task_notification`.
- Width clamping: the 75 % ceiling, and the detail panel yielding first.
- A moon without `toolUseId` does not open a panel.
