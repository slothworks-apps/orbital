---
id: subagent-liveness-from-sdk-task-events
title: Subagent liveness comes from SDK task events, not transcript blocks
type: adr
status: in-force
domain: subagents
related:
  - subagents-in-transcripts
  - subagents-only-for-orbital-sessions
  - background-agents-retire-their-moon-at-launch
---

# Subagent liveness comes from SDK task events, not transcript blocks

## Context

A moon orbits a session planet while one of its subagents works. The server
learned "working" from an `Agent` `tool_use` block on the SDK stream and
"ended" from the `tool_result` that answers it. That was true when `Agent`
blocked until the subagent returned.

Claude Code 2.1.236 runs `Agent` in the background by default. The
`tool_result` now comes back about 70 ms after launch and says only that the
agent started; the agent's real end arrives minutes later as a
`<task-notification>` user message. Read through tool blocks, every moon
blinked once and vanished ([[background-agents-retire-their-moon-at-launch]]).

## Options

1. **Keep reading tool blocks, recognise the placeholder.** Treat a
   `tool_result` whose text starts with "Async agent launched successfully"
   as "still working", and parse `<tool-use-id>` and `<status>` out of the
   later `<task-notification>` string. Works, but rests on two prose formats
   the CLI can reword at any time, and has nothing to say about an agent the
   user resumes.
2. **`SubagentStart` / `SubagentStop` hooks** (`options.hooks`). In-process
   callbacks, but they carry only `agent_id` and `agent_type`: no
   `tool_use_id` to join to the transcript, no description to name the moon.
3. **The SDK's task lifecycle `system` messages.** `task_started` and
   `task_notification` bracket the real work, for foreground and background
   agents alike, and carry `task_id`, `tool_use_id`, `description`,
   `subagent_type`, `task_type`, `is_backgrounded`. `background_tasks_changed`
   is the level signal beside them: the full live set, replace semantics, which
   the SDK itself recommends so a missed edge cannot wedge a stale indicator.

## Decision

Option 3. `Runner.pump()` forwards the three subtypes to `onTaskEvent`;
`SubagentTracker.feedTask()` takes `working` from `task_started` when the task
is a `local_agent` and not `ambient`, `ended` from `task_notification` with
any status, and retires a backgrounded agent missing from a
`background_tasks_changed` payload. Agents are keyed by `task_id`; the
`tool_use_id` rides along for joining to the transcript.

The tool-block reader (`feed()`) stays as the after-the-fact record a
terminal session leaves behind, on its own keyspace, so a launch result can
never retire a live agent.

## Consequences

- A resumed agent gets a fresh `task_started`, so resume is handled with no
  extra state.
- Terminal sessions still cannot show a live moon; nothing here changes
  [[subagents-only-for-orbital-sessions]].
- The tracker now depends on three `system` subtypes by name. A rename would
  fail the same way the `Task` to `Agent` rename did: silently. The
  end-to-end test mirrors the real stream order so at least the shape is
  pinned.
