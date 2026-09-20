---
id: subagents-in-transcripts
title: What a transcript says about subagents, and when
type: domain
status: in-force
domain: subagents
related:
  - 2026-09-16-subagents-everywhere-design
  - 2026-09-15-orbital-design
---

# What a transcript says about subagents, and when

Measured against Claude Code **2.1.236** on 2026-09-16, by reading every
`.jsonl` under `~/.claude/projects`.

## The tool is called `Agent`

Not `Task`. Across every transcript on this machine, `"name":"Task"` appears
**zero** times; `Agent` appears 58 times in the last six hours alone. The
input shape is unchanged — `description`, `subagent_type`, `prompt` — so only
the name moved.

The original spec (`2026-09-15-orbital-design`, § Data sources) says "`Task`
tool calls inside transcripts" and was written against an older CLI. Detection
built on that name matches nothing at all.

`SubagentTracker` now accepts both names. A future rename will break it the
same way, silently: nothing errors, subagents simply stop being found.

## A blocking subagent is not in the transcript while it runs

Both lines — the `Agent` `tool_use` and its `tool_result` — are written when
the subagent **finishes**. Two independent observations:

- Every completed `Agent` call has ~70 ms between its `tool_use` timestamp and
  its `tool_result`, for work that plainly took minutes. Consecutive calls sit
  8 minutes apart while each pair is internally 70 ms wide.
- With a subagent visibly running for 9 minutes in the terminal UI, a scan of
  every transcript found **no** unresolved `Agent` call anywhere.

So for a terminal session the observable "running" window is ~70 ms. **No
amount of transcript watching can show a moon while a subagent is working.**
What transcript watching gives is an accurate record after the fact.

The terminal UI knows because the CLI holds it in memory. The only live
channel out of a terminal session is its messaging socket,
`/tmp/cc-socks/<pid>.sock` (named in the registry file as
`messagingSocketPath`) — undocumented, and a non-goal in the original spec.

`~/.claude/tasks/` is not it: on this machine its newest directory is two
weeks old and holds only `.lock` and `.highwatermark`.

## A background subagent leaves two records, minutes apart

Measured 2026-09-20 in an orbital web session (`353af9e1-…`). `Agent` runs
in the background by default now, and the transcript shows it in two places:

- The `tool_use` and a `tool_result` 74 ms later whose text begins
  `Async agent launched successfully` and names an `agentId`. This is the
  launch, not the result.
- Five minutes later a `user` line whose `message.content` is a **string**,
  not a block array: `<task-notification>` with `<task-id>`,
  `<tool-use-id>`, `<status>completed</status>`, a `<summary>` and the
  agent's `<result>`. The same text also appears as `queue-operation`
  lines (`enqueue`, then `remove`) while it waits for the next turn.

So the pair-of-lines finding above holds only for `run_in_background: false`.
For a background agent the transcript does bracket the real work — but a
reader that retires an agent on its first `tool_result` sees a 74 ms life,
which is what [[background-agents-retire-their-moon-at-launch]] was.

The notification's own `<note>` says one task may notify more than once: the
user can resume an agent with `SendMessage`, after which it works and
notifies again with the same `task-id`.

## Where live subagent state comes from

Orbital's own sessions, and only from the SDK stream. The runner reads it as
it is produced, and Claude Code reports a task's life there as `system`
messages (`@anthropic-ai/claude-agent-sdk` 0.3.272, `sdk.d.ts`):

- `task_started`: `task_id`, `tool_use_id`, `description`, `subagent_type`,
  `task_type` (`local_agent` for a subagent; `local_bash` for a background
  shell), `is_backgrounded`, `spawn_depth`, `ambient`.
- `task_notification`: `task_id`, `tool_use_id`, `status` of `completed`,
  `failed` or `stopped`.
- `task_progress`: `usage`, `last_tool_name`, `summary`. Not consumed yet.
- `background_tasks_changed`: the full set of live background tasks, replace
  semantics, ids only.

The tracker takes `working` from `task_started` and `ended` from
`task_notification`, with `background_tasks_changed` as the safety net for a
backgrounded agent whose notification never comes. The tool blocks are not
consulted for liveness at all ([[subagent-liveness-from-sdk-task-events]]).
Tested 2026-09-20 against a fake stream in the real message order; the first
real web session with three agents is what found the bug.
