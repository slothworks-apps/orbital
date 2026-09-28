---
id: cloud-sessions-in-the-session
title: Show the cloud sessions a session launched
status: backlog
type: idea
domain: sessions
related:
  - subagent-liveness-from-sdk-task-events
tags:
  - detail-panel
  - background-tasks
---
# Show the cloud sessions a session launched

A session can start work that runs in the cloud rather than on this
machine — `/code-review ultra`, ultraplan and the like. The SDK reports
it on the same task stream as subagents and background shells, as
`task_type: 'remote_agent'` (the CLI's own label for it is "cloud
session"): `task_started` when it launches, `task_notification` when it
ends, and it sits in every `background_tasks_changed` payload in between.

Orbital drops these today, the same as every task type except
`local_agent`. It was left out on purpose when background shells,
monitors, workflows and MCP tasks got their list in the detail panel
(2026-09-28): a cloud session is rare, is started by the user rather
than the agent, and cannot be stopped from here the way a local process
can.

## What it would take

- Stop filtering `remote_agent` out where the background-task list reads
  the task events, and give it a row: description, running or ended,
  elapsed time. No stop control.
- The CLI keeps more on the task than the SDK sends — the cloud
  session's id, its title, whether it is an ultraplan or a review. The
  SDK message carries only `description`, so a link to the session on
  claude.ai would need that id from somewhere else.
- Decide whether a running cloud session keeps the parent at `working`
  the way a running subagent does. A review that takes twenty minutes
  would otherwise leave the planet reading `needs input` while nothing
  is actually asked.
