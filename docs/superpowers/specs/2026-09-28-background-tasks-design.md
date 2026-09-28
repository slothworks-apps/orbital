---
id: 2026-09-28-background-tasks-design
title: Background tasks — the shells, monitors, workflows and MCP tasks a session left running
type: spec
status: draft
domain: sessions
related:
  - subagent-liveness-from-sdk-task-events
  - subagents-only-for-orbital-sessions
  - what-a-session-waits-for-is-a-label
  - 2026-09-24-subagent-list-design
  - 2026-09-22-subagent-transcript-panel-design
  - streamed-text-rides-as-offset-deltas-on-the-rows-id
  - cloud-sessions-in-the-session
tags:
  - detail-panel
  - background-tasks
  - server
---

# Background tasks

Decided with Tomin, 2026-09-28. The visual design is not done yet: it is
to be drawn in Claude Design first (the prompt is in the brainstorming
session that produced this spec), and this spec records what was agreed
about behaviour, not the pixels.

## Why

An agent can start work that outlives its turn: a `Bash` call with
`run_in_background`, a `Monitor`, a `Workflow`, an MCP tool that finishes
in the background. Orbital shows none of it. A session whose turn ended
with a shell still running reads as finished, and a dev server the agent
started to check something keeps running — and holding its port — all
day without anyone noticing.

The session detail gets a list of these tasks: what runs, what ended and
how, with a stop control and, for shells, their output. The map shows
nothing new beyond the wording of the existing state pill.

## 1. What is tracked

The SDK reports every task on the same three `system` messages the
subagent tracker already reads (`task_started`, `task_notification`,
`background_tasks_changed`), plus `task_updated`. `task_type` tells them
apart. The CLI bundled with SDK 0.3.278 knows these types:

| `task_type` | the CLI calls it | what starts it | here |
|---|---|---|---|
| `local_agent` | subagent | `Agent` | already moons and the subagent list |
| `local_bash` | shell | `Bash` with `run_in_background`, and `Monitor` | **tracked** |
| `monitor_mcp` | monitor | a monitor on an MCP tool | **tracked** |
| `local_workflow` | workflow | `Workflow` | **tracked** |
| `mcp_task` | MCP task | an MCP tool that finishes in the background | **tracked** |
| `remote_agent` | cloud session | `/code-review ultra`, ultraplan | not yet ([[cloud-sessions-in-the-session]]) |
| `in_process_teammate` | teammate | agent teams (experimental) | no |
| `monitor_ws` | monitor | websocket watchers, nearly always `ambient` | no |
| `dream` | dream | memory upkeep, always hidden by the CLI | no |
| `auto_mode_scan` | auto-mode scan | auto mode's own checks | no |

Rules:

- **`ambient` is dropped**, on `task_started` and in
  `background_tasks_changed`, as the SDK asks hosts to.
- **Only background work.** `local_bash` also fires `task_started` for a
  foreground `Bash` (`is_backgrounded: false`). Such a task is held but
  not shown until a `task_updated` with `patch.is_backgrounded: true`
  moves it to the background; if it ends first, it never appears.
- **Monitor vs Bash.** Both are `local_bash`; the SDK does not send the
  CLI's internal `kind`. The task's `tool_use_id` names the call that
  started it, and that call's tool name (`Bash` or `Monitor`) decides.
  With no `tool_use_id`, or a call the server has not seen, it is a
  shell.
- **Orbital sessions only.** The events exist only on the SDK stream, the
  same limit [[subagents-only-for-orbital-sessions]] records. Terminal
  sessions never have background tasks.

## 2. Server

### The tracker

A `BackgroundTaskTracker` per session, in a store beside `SubagentStore`,
fed by the same `onTaskEvent` in `index.ts`. `TASK_EVENT_SUBTYPES` gains
`task_updated`. The subagent tracker keeps its own filter and ignores
everything this one takes.

A task on the wire (`ApiSession.backgroundTasks`, every task the session
has had, ended included, in start order):

| field | meaning |
|---|---|
| `id` | the SDK `task_id` |
| `kind` | `shell` · `monitor` · `workflow` · `mcp` (`monitor_mcp` is a `monitor`) |
| `label` | `description` from `task_started`; a workflow uses `workflow_name` when present |
| `command` | shells and `Monitor` only: the `command` input of the launching call |
| `state` | `running` · `ended` |
| `status` | once ended: `completed` · `failed` · `stopped`, from `task_notification`; absent when the task was retired without one |
| `startedAt`, `endedAt` | epoch ms |
| `hasOutput` | true when the server knows an output file for it (§ 4) |

The command and the Monitor/Bash split need the launching `tool_use`
block. The Runner already sees every assistant message before the
`task_started` it causes; it keeps `tool_use_id → { name, input }` for
`Bash` and `Monitor` calls of the session, and the tracker reads it when
the task starts.

**Ending.** A task ends on its `task_notification`, on a `task_updated`
with a terminal `patch.status`, or when it is missing from a
`background_tasks_changed` payload (the level signal, as the subagent
tracker already uses it). When the session's CLI process exits — the
session ended, or it crashed — every running task is ended without a
`status`: the background processes die with the CLI. The store is in
memory; after a server restart the list starts empty, like the subagent
list.

### Working while a task runs

A running tracked task keeps the session `working` when its own turn is
over, exactly as a running subagent does today
([[what-a-session-waits-for-is-a-label]]). This applies to shells and
monitors too, deliberately: a dev server left running keeps the planet
`working` for as long as it runs. That is the point — it is visible, the
label says what is waited for, and it is one click from being stopped.

`hasLiveSubagents` widens to "anything the session launched is still
running". `ApiSession` gains what the label needs: counts of the running
tasks by `kind`, beside `awaitingSubagents`. The wording of the state pill
and the detail chip (today `WAITING FOR AGENT`) comes from the design; one
shared function still produces it for both.

### Stop

`POST /api/sessions/:id/tasks/:taskId/stop` calls the SDK's
`query.stopTask(taskId)`. The resulting `task_notification` with
`status: 'stopped'` ends the task through the normal path; the route
does not end it itself.

- `404` — the session is not one Orbital runs, or has no such task.
- `409` — the task has already ended.
- `204` — the stop was sent.

No confirmation dialog: stopping a background task breaks nothing the
agent cannot start again.

`perTaskStopAffordance` is **not** declared. Declaring it makes the
composer's interrupt spare running background agents and workflows,
which is a separate change to what Stop means, and subagents have no stop
control of their own yet.

## 3. Web

- The detail panel gets the list of background tasks, running and ended,
  with a stop control on running rows. No task, no list: a session that
  never had one shows nothing.
- A shell or monitor row with `hasOutput` opens its output (§ 4). A
  workflow or MCP task has no output to open.
- The map shows nothing new except the state pill's wording.
- Where the list sits, how a row reads and how the output view looks come
  from the Claude Design artboards, not from here.

## 4. Output of shells and monitors

**Where it is.** The CLI appends a background shell's stdout and stderr
to a plain text file, live, and ends it with `[exited with code N]`:
`/private/tmp/claude-<uid>/<cwd slug>/<session id>/tasks/<task id>.output`.
The launching `Bash` call's `tool_result` gives the exact path at launch
("Output is being written to: …"), and `task_notification.output_file`
gives it again at the end. The server takes the path from those two
places only and never builds it from the pattern above.

**Reading.** `GET /api/sessions/:id/tasks/:taskId/output?before=<offset>`
returns a chunk of the file ending at `before` (the end of the file when
omitted), at most `OUTPUT_CHUNK_BYTES`, cut forward to a line start, with
the chunk's start offset and the file's size. Scrolling up asks for the
chunk before. The path comes only from the tracker's record for that
task, so the route cannot be pointed at any other file. `404` for an
unknown task; `410` when the file is gone (`/tmp` does not survive a
reboot) — the view then says the output is no longer available.

**Following.** While a view is open, the web subscribes to the task's
output over the WebSocket; the server watches that one file and pushes
appended bytes as `{ offset, text }`, the same offset-delta shape the
streamed transcript text uses
([[streamed-text-rides-as-offset-deltas-on-the-rows-id]]). No file is
watched while nobody has it open.

**ANSI.** Escape sequences are stripped, and a `\r` without `\n`
replaces the line it returns to, so progress bars read as their last
state. Colour is not kept in this version.

## Out of scope

- Cloud sessions (`remote_agent`) — [[cloud-sessions-in-the-session]].
- Output of workflows and MCP tasks, and colour in shell output.
- Terminal sessions.
- Declaring `perTaskStopAffordance` (§ 2, Stop).
- Telling a subagent's background tasks from the main loop's: whatever
  reaches the session's SDK stream is listed under the session.

## Tests

- Tracker: which `task_type`s it keeps; `ambient` dropped on both
  messages; a foreground `local_bash` hidden until `task_updated` moves
  it to the background, and never shown if it ends first; Bash vs
  Monitor from the launching call; each of the three ways a task ends;
  every running task ending when the CLI process exits.
- `working` while only a background task runs, and the counts the label
  reads.
- Stop route: `404`, `409`, `204`, and that it calls `stopTask`.
- Output route: a chunk cut to a line start, paging with `before`, `410`
  for a missing file, and that no request reaches a path the tracker did
  not record.
- ANSI stripping and `\r` handling.
