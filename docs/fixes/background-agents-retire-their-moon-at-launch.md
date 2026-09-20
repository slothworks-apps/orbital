---
id: background-agents-retire-their-moon-at-launch
title: A background agent's moon is retired the moment it launches
status: done
type: fix
domain: subagents
related:
  - subagents-in-transcripts
  - 2026-09-16-subagents-everywhere-design
  - subagent-liveness-from-sdk-task-events
tags:
  - server
  - subagents
---
# A background agent's moon is retired the moment it launches

## What happens

Run three agents from a web session. Each moon blinks once and is gone; none
stays in orbit for the minutes the agent actually works.

## What it turned out to be

`SubagentTracker` (`server/src/transcript/subagents.ts`) marks an agent
`ended` on the first `tool_result` whose `tool_use_id` matches the `Agent`
`tool_use`. That was right when `Agent` blocked until the subagent returned.
It no longer does.

Claude Code 2.1.236 runs `Agent` **in the background by default**. The
`tool_result` comes back about 70 ms after the `tool_use` and says only that
the agent was launched:

```
Async agent launched successfully. (This tool result is internal metadata …)
agentId: a1ee46c1ffba10b0a …
```

The agent's real end arrives minutes later as a separate `user` message whose
content is a **string**, not a block array:

```
<task-notification>
<task-id>a1ee46c1ffba10b0a</task-id>
<tool-use-id>toolu_01VdUjd9HDFDkYoP5qsHZgdx</tool-use-id>
<status>completed</status>
<summary>Agent "Prune visuals.test.ts per rule" finished</summary>
…
</task-notification>
```

Measured in `~/.claude/projects/-Users-tomin-Projects-slothworks-orbital/353af9e1-….jsonl`
on 2026-09-20: `tool_use` 11:31:05.894, launch `tool_result` 11:31:05.968,
task-notification 11:36:25.682.

So the store sees `working` and then, one batch later, `ended`. The web
side (`sceneModel.ts`) drops an `ended` subagent from the model, which is the
blink. The tracker's `feed()` also skips any entry whose content is not an
array, so the notification that should retire the agent is never read.

The runner path is fine: the SDK stream delivers both the launch result and
the notification, so the fix is entirely inside the tracker.

## What to change

Stop scraping `tool_use`/`tool_result` blocks for this at all. The Agent SDK
(`@anthropic-ai/claude-agent-sdk` 0.3.272, `sdk.d.ts`) streams the subagent
lifecycle as `system` messages, and `Runner.pump()` currently drops every
`system` subtype except `init` and `commands_changed`:

- `system/task_started` — `task_id`, `tool_use_id`, `description`,
  `subagent_type`, `task_type` (`local_agent` for subagents; `local_bash`
  for background shells), `is_backgrounded`, `spawn_depth`, `ambient`.
- `system/task_notification` — `task_id`, `tool_use_id`, `status`
  (`completed` | `failed` | `stopped`).
- `system/task_progress` — `usage`, `last_tool_name`, `summary`; not
  needed for the fix, but it is what a moon could show later.
- `system/background_tasks_changed` — the full live set with REPLACE
  semantics. The SDK's own advice for "is background work running": swap the
  set on every payload so a missed edge cannot wedge a stale indicator. Ids
  only, and only background tasks, so it complements the pair above rather
  than replacing it.

Both edges fire for foreground and background agents alike, and a resumed
agent gets a fresh `task_started`, which also closes the resume question
below. Hooks `SubagentStart`/`SubagentStop` exist too (`options.hooks`),
but carry only `agent_id`/`agent_type`, no `tool_use_id` or description.

So:

1. `Runner.pump()` forwards `task_started` / `task_notification` (and,
   as the safety net, `background_tasks_changed`) to a new callback.
2. `SubagentTracker` keys agents by `task_id`, takes `working` from
   `task_started` where `task_type === "local_agent"` and not `ambient`,
   and `ended` from `task_notification`. The `tool_use_id` is kept for
   joining to the transcript.
3. The transcript-scraping path stays only as the after-the-fact record for
   terminal sessions, which have no SDK stream ([[subagents-in-transcripts]]).

Then update [[subagents-in-transcripts]]: its "written when the subagent
finishes" finding describes the blocking mode only, and its "untested" note is
now tested.

Resume: the notification's own `<note>` says a task may notify more than
once, because the user can resume an agent with `SendMessage`. With
`task_started` as the working edge this is handled for free; with the old
tool_use scraping it was not.
