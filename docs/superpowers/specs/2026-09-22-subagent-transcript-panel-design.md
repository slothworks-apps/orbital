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
  - 2026-09-23-detached-session-windows-design
  - 2026-09-24-subagent-list-design
---

# Subagent transcript panel

Design: `Feature - Subagent panel.dc.html`, artboards 11a–11e. (This lived in
the frontmatter as a `design:` key, which atlas does not recognise and which
failed `atlas validate`; the pointer is worth keeping, the key was not.)

## The problem

A moon on the map says a subagent is running and nothing else. What it is
doing — which files it read, which commands it ran, what it is about to
report back — is invisible until it finishes and the parent summarises it in
one line. The interesting window is exactly the one that is closed.

Orbital runs `Agent` in the background, so the parent keeps working while the
agent does. Watching the two side by side is the point: the moment worth
seeing is the agent returning and the parent reacting to it.

The design is canvases **11a–11e** of `Feature - Subagent panel.dc.html`.
Where this spec and the canvases disagree on a pixel, the canvas wins; where
they disagree on behaviour, this document records the decision.

### Scope

**Orbital's own sessions only.** Moons exist only for sessions the Runner
owns — `onTaskEvent` in `server/src/index.ts` is, as its comment says, "the
one feeder", and it is fed solely by the SDK stream. Terminal sessions get
`subagents: []` and therefore no moons. They are out of scope by decision:
the CLI has its own subagent viewer.

**One session's agents, for as long as the session lives.** The panel is not
an archive. There is no browser of past sessions' subagents and no
pagination. But within a live session nothing is thrown away while it is
still held: an agent that has finished stays reachable until the user
dismisses it (§ 4).

**Read-only.** Writing to a subagent was considered and dropped. The SDK
exposes no host-side channel to a running task — `Query` has no such control
request — so a "message the agent" feature would have had to inject an
instruction into the *parent* session asking it to relay via `SendMessage`.
That costs a parent turn, can derail the parent's work, and is not the thing
it would appear to be. The panel has no composer, and canvas 11b spends a
permanent footer strip (`read-only · a subagent takes no input`) on saying
so.

### Deferred

**The sub-1010 px layout.** Two panel minimums plus gutters need 756 px,
which breaks the 75 % ceiling below roughly 1010 px of viewport. Canvas 11d
answers this with a second layout mode — the agent panel takes the session
panel's slot, its header gains a `↖ <session>` back control, and closing the
agent restores the session rather than the map. It is fully designed and
deliberately **not** built in v1: it is the largest single layout item here
and the target machine rarely reaches that width. Below 1010 px the panels
simply sit tight against the ceiling. When it is built, 11d is the spec.

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
agent's buffer sees only the `tool_use` block. Canvas 11b draws it as a
dashed row badged `DEPTH 2`, not pressable: depth-2 agents have no moon and
no panel. Nothing is lost, there is simply no way in yet.

## 3. `SubagentTranscripts`

A new store beside `SubagentStore` in `server/src/transcript/subagents.ts`,
with the same lifetime.

- Key: `sessionId` + `parent_tool_use_id`. Value: a ring buffer of
  `ChatMessage`.
- **The buffer outlives the agent, not the session.** `task_notification`
  retires the agent; the buffer stays until `drop(sessionId)`. Both open
  questions this design has — catching up a panel opened mid-run, and having
  something to freeze when the agent ends — are the same buffer.
- Cap of 2000 `ChatMessage` per agent — comfortably above any agent run
  measured so far (the largest subagent transcript on this machine is ~100 kB
  / a few hundred entries), low enough that a runaway agent cannot grow the
  server without bound.
- **The buffer counts what it dropped**, as a number, not a flag. Canvas 11c
  names both figures — "The first 1 184 steps of this run were dropped" next
  to "buffer 2 000 steps" — so `droppedCount` rides the REST response and
  the WS increments.

## 4. Moons outlive their agents

**2026-09-24: superseded on the map side.**
[[2026-09-24-subagent-list-design]] § 5 has a moon leave the map the instant
its agent ends, so the "an ended moon stays until the user dismisses it"
bullet below no longer holds, and dismissal is gone. `SubagentStore.all()`
and `running()` stand as described — the list and the `OPEN →` row still
read `all()`, `hasLiveSubagents` still reads `running()` — and the buffer
still outlives the agent ([[subagent-buffer-outlives-the-agent]]).

Today `SubagentStore.get()` returns only running agents and
`web/src/map/sceneModel.ts` filters `state !== 'ended'`, so a moon vanishes
the instant its agent reports back — taking the only way into its transcript
with it.

- `SubagentStore` splits into **`all()`** and **`running()`**. The map, the
  REST shape and the WS snapshot read `all()`; `hasLiveSubagents` reads
  `running()` and must keep doing so, or a session whose agents have all
  finished would hang at `working`.
- `sceneModel` stops filtering ended agents. Canvas 1f already draws an
  `ended` moon — `MOON_STATES` has carried the state all along — so this is
  a filter removal, not new geometry.
- **An ended moon stays until the user dismisses it**, not on a timer. The
  dismissal is a set of subagent ids held beside the buffer, in memory, on
  the same lifetime as everything else here. It mirrors `map_dismissed_at`
  on sessions, one scope down.

## 5. Two ways in

**The moon** (canvas 11e). Openable moons get no resting decoration — the
map stays a map. Hover gives a white rim, brighter core, one outer halo ring
and a label naming the task, with a pointer cursor. Active gives corner
brackets (the selected-planet language at moon scale, 19 px out, 7 px arms)
plus a dashed tether toward the panel. Hit area 40 px.

**The parent transcript's agent row** (canvas 11a). The `Agent` tool row in
the session's own transcript gains an `OPEN →` control. Unlike the moon this
is part of the record forever, so an agent is still reachable after scrolling
back through a long session — and after the moon has been dismissed.

A moon or row whose `SubagentInfo` has no `toolUseId` cannot be joined to a
buffer. `task_started.tool_use_id` is optional in the SDK, so this is
possible; such a moon drops to the ended-moon greys, holds still, takes no
hover and no pointer, and is skipped by the tab order entirely. It reads as
decoration, not as breakage.

**Keyboard.** Moons join their planet's tab order; `↵` opens the panel, `⎋`
closes it. Inert moons are not in the order.

## 6. `SubagentInfo` gains two fields

- `startedAt` (epoch ms, stamped on `task_started`) — the panel header shows
  elapsed time, which is the headline number for a thing you are watching
  run.
- `status` — the terminal status from `task_notification`. The tracker today
  treats `completed`, `failed` and `stopped` identically ("Any status ends
  the moon"), which is right for the moon and wrong for a frozen panel: which
  of the three happened is the first thing a reader wants.

The model needs no field: assistant frames carry `message.model`, which
`ChatMessage` already transports.

Note on `stopped`: canvas 11c glosses it as "stopped from the parent
session", but Orbital offers no way to stop a subagent. The status can arrive
from the SDK — a CLI-side stop, a parent that gave up — so the badge must
exist, but nothing in Orbital can currently produce it.

## 7. Thinking blocks and tool durations

Both are drawn in canvas 11b and neither exists today.

**Thinking.** `sdkToChatMessages` (`server/src/runner/runner.ts`) handles
`text`, `tool_use`, `tool_result` and `image`, and drops `thinking` on the
floor; `ChatMessage` has no field for it. It gains one, and the renderer
draws it — in canvas 11b as a block labelled `THINKING` with a left hairline
rather than a box, because at 380 px boxed blocks stack badly.

This lands in the **parent** transcript too, by decision: an inconsistency
where the same content renders in one panel and not the other is worse than
the change. The parent is the wider surface and keeps the boxed treatment of
canvas 1b; only the subagent panel uses the hairline variant.

**Durations.** `sdkToChatMessages` sets no `timestamp` at all, and
`summarizeToolRun` returns `{ count, breakdown }` with no time in it.
Messages are stamped at publish, each tool row shows its own duration from
the `tool_use`/`tool_result` pair ("Read: eslint.config.js · 0.3s"), and a
folded run shows the sum ("4 tool calls · Read ×3, Grep ×1 · 6.2s").

## 8. The panel

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

Per canvas 11b. Eyebrow `SUBAGENT · READ-ONLY`, the parent session's name,
the agent's `description` from `task_started` (15 px / 600, clamped to two
lines), a chip with its `subagent_type` (the 1e resting chip, unfilled), a
state badge (5 px radius, mono 9.5 px), its model, and elapsed time. Header
padding 18 px against the session panel's 22 — the agent panel is one step
tighter at every level.

Body: `TranscriptView`, one size down from canvas 1b — prose 12.5 px, tool
rows mono 11 px, folded runs and expanded results identical to 1b and the 8a
INPUT / OUTPUT frames.

**No user bubbles.** A subagent has exactly one instruction and it is
already the title; the leading user frame is suppressed rather than
duplicated into the body.

Footer: the permanent `read-only · a subagent takes no input` strip and the
close control. No composer, no send control, no stop control — stopping a
subagent, if it ever exists, happens in the parent session.

**Accent** is the parent session's tag hue, falling back to
`oklch(85% .12 205)`.

### Layout

The panel slides in at the right edge and pushes the detail panel left.

- Default 380 px, minimum 320 px.
- The two panels together are capped at 75 % of the viewport.
- **The detail panel yields first**, down to its existing 360 px minimum. The
  reader opened the agent; the parent is what gives way.
- Three cues separate the two panels, none of them colour: a width step
  (450 → 380), a depth step (the agent panel is flatter and darker, with an
  inset shadow on its left edge, so it reads as recessed), and a top-edge
  seam.
- In a detached session window the panel sits flush beside the detail panel
  and the window grows to make room — see
  [[2026-09-23-detached-session-windows-design]] § "The subagent panel in the
  window".

### Lifecycle

| Event | Result |
|---|---|
| Click a moon, or `OPEN →` on an agent row | Panel opens on that agent |
| Click another moon | Content switches; one slot, panels do not stack |
| Agent ends | Panel stays, frozen, with the final report; the moon stays too |
| Moon dismissed | That moon leaves the map; the row's `OPEN →` still works |
| Detail panel closes | Subagent panel closes with it |
| Another planet selected | Subagent panel closes — it belonged to the old session |

## 9. API surface

- `GET /api/sessions/:id/subagents/:toolUseId/messages` → the buffer, as
  `ChatMessage[]`, plus `droppedCount`. `404` when no buffer exists for that
  pair.
- WS topic `subagent:<sessionId>:<toolUseId>` → `{ event: 'message',
  message }` increments, mirroring `session:<id>`.

## 10. States and errors

Canvas 11c is the sheet. Five task states plus one modifier:

| | |
|---|---|
| `RUNNING` | Accent plus a blinking dot; elapsed ticks. The only state that animates. |
| `COMPLETED` | Report returned. Elapsed freezes at its final value. |
| `FAILED` | Errored out. The last transcript row carries the error; the badge only says it stopped being true. |
| `STOPPED` | Neutral, square-dotted — a choice, not a fault. |
| `STREAM LOST` | Dashed border, hollow dot. |
| `TRUNCATED` | **A modifier, not a state.** It composes with all five above. |

**`STREAM LOST`** is the server restart, or `drop()` under an open panel. The
buffer is memory only. The body must render empty *with a reason* — canvas
11c puts the reason block where the first transcript row would be, closed by
a dashed rule, so the space below reads as "nothing to show" and never as
"nothing happened". Elapsed reads `elapsed unknown`, never zero.

**`TRUNCATED`** puts a filled panel chip — not a hairline, it has to survive
a fast scroll — pinned at the top of the scroller, naming both numbers from
§ 3. It is part of the record, not chrome.

These are task statuses. The moon keeps the canvas 1f vocabulary
(`materializing` / `working` / `idle` / `needs_input` / `ended`); the two
sets must not be mixed.

## 11. Testing

Server (70 tests today):

- `pump()` routing against a fake stream with mixed `parent_tool_use_id`,
  following the existing fake-stream pattern used for task events.
- Regression for § "The bug this uncovers": a stream carrying a subagent
  `tool_use` publishes nothing on `session:<id>`.
- Buffer: eviction at the cap, `droppedCount` accuracy, `drop()` at session
  end.
- `startedAt` and `status` populated from the task events.
- `all()` includes ended agents and `running()` does not — asserted together,
  since the bug this prevents is a session stuck at `working`.
- Thinking blocks survive `sdkToChatMessages`; messages carry a publish
  timestamp.

Web (352 tests today):

- `transcript.test.tsx` and `transcriptmotion.test.ts` pass **unedited**.
- Panel lifecycle: open from a moon, open from `OPEN →`, switch, close with
  parent, close on reselect, freeze on `task_notification`.
- An ended moon stays on the map and opens; a dismissed one goes.
- Width clamping: the 75 % ceiling, and the detail panel yielding first.
- A moon without `toolUseId` does not open a panel and is not tabbable.
- `STREAM LOST` renders a reason, never a bare empty transcript;
  `TRUNCATED` renders its marker and composes with `RUNNING`.
- The leading user frame is suppressed in the subagent panel.
- Tool rows show durations; a folded run shows the sum.
