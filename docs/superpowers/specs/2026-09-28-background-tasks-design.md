---
id: 2026-09-28-background-tasks-design
title: Background tasks — the shells, monitors, workflows and MCP tasks a session left running
type: spec
status: draft
domain: sessions
related:
  - background-shell-output-is-not-forced-into-colour
  - the-composers-stop-spares-background-work
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

Decided with Tomin, 2026-09-28. Source: Claude Design,
`Feature - Background tasks.dc.html`, artboards 26a–26e. Read it through
DesignSync; this spec records what was agreed, not the pixels. Where the
artboards assume something the SDK does not do, this spec wins and the
difference is listed in § 5.

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
| `status` | once ended: `completed` · `failed` · `stopped`, from `task_notification`; absent when the task was retired without one (the UI's "unknown") |
| `exitCode` | shells and monitors only, once ended: read from the output file's last line, `[exited with code N]`; absent when that line is not there |
| `startedAt`, `endedAt` | epoch ms |
| `toolUseId` | the launching call, so the transcript row can offer `OUTPUT →` |
| `hasOutput` | true when the server knows an output file for it (§ 4) |

The SDK does not send an exit code. The CLI writes one as the output
file's closing line, which is the only source; the tracker reads it once,
when the task ends.

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
`status`: the background processes die with the CLI.

### Persistence

Tasks are kept in SQLite, table `background_tasks` (migration after
`0015`), one row per task, keyed by `(session_id, task_id)`, cascading
with the session. The row holds every wire field above plus the output
file path. The tracker writes through on every change; at startup it
loads the rows, and any still `running` is ended without a `status` —
the server's restart took its CLI process, and the processes with it.
So ended tasks, their exit codes and their output (while the file
lasts) survive a restart of Orbital. Subagents stay in memory; this does
not change them.

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

### The composer's Stop stops only the turn

The Runner declares `perTaskStopAffordance: true`. Without it the CLI
fails closed and the composer's interrupt kills running background
agents and workflows along with the turn; with it, Stop aborts the turn
and the tasks keep running, as 26a says. Each one then has its own stop:
tasks in this list, and **subagents in theirs** — the subagent list
(25a) gains the same ■ on running rows, calling the same route with the
subagent's `task_id` (`stopTask` takes any task id). See
[[the-composers-stop-spares-background-work]].

To verify when implementing: the SDK's wording names agents and
workflows; whether an undeclared interrupt also kills background shells,
and whether a declared one spares them, is checked against the real CLI
before the UI claims it.

## 3. Web

- **The ▣ chip** (26a, 26e) sits in the detail header's state row right
  after the subagent chip. It shows the running count and, once the
  oldest running task passes `TASK_AGE_SHOWN_AFTER_MS`, its age; with
  nothing running, the ended counts. No task ever, no chip. When both
  chips are shown in a narrow session column the two take their compact
  forms (26c's rule).
- **The list** is the `ui/Menu` dropdown the subagent list uses:
  `RUNNING`, then `ENDED`. ■ on a running row stops the task without
  opening the row. The row stays in `RUNNING` with the stop pending until
  the `task_notification` arrives — no optimistic move, so a stop that
  fails does not leave a lie behind.
- **The output view** (26b) opens a shell or monitor in the subagent
  slot: the same single slot, so opening one replaces an open subagent
  and the other way round. Header with the full command wrapped, state,
  elapsed, ■ while running. The body follows the tail; scrolling up
  pauses following and the footer counts the new lines; the client keeps
  the last `OUTPUT_BUFFER_LINES` lines. A workflow or MCP task has no
  output to open.
- **`OUTPUT →`** on the transcript's row for a background `Bash` or
  `Monitor` call opens the same view, joined by `toolUseId`, like
  `OPEN →` on a subagent's row.
- **The waiting label** (26d): agents first, then tasks, joined by `+`,
  at most two terms; a count of one is dropped, from two it is shown —
  `WAITING FOR 2 AGENTS` replaces today's countless plural; one kind is
  named, mixed kinds read `TASKS`. The map pill spells it out; the detail
  row reads `WAITING FOR` and lets the chips carry the nouns.
- The map shows nothing new except that wording.
- Detached window: 26c, the 25b pane/swap rules unchanged.

## 4. Output of shells and monitors

**Where it is.** The CLI appends a background shell's stdout and stderr
to a plain text file, live, and ends it with `[exited with code N]`:
`/private/tmp/claude-<uid>/<cwd slug>/<session id>/tasks/<task id>.output`.
The launching `Bash` call's `tool_result` gives the exact path at launch
("Output is being written to: …"), and `task_notification.output_file`
gives it again at the end. The server takes the path from those two
places only and never builds it from the pattern above.

**Reading.** `GET /api/sessions/:id/tasks/:taskId/output` returns the
file's tail — at most `OUTPUT_TAIL_BYTES`, cut forward to a line start —
with the file size as the offset the next delta continues from. There is
no paging further back: the view holds the last `OUTPUT_BUFFER_LINES`
lines and older ones drop off (26b). The path comes only from the
tracker's record for that task, so the route cannot be pointed at any
other file. `404` for an unknown task; `410` when the file is gone —
`/tmp` does not survive a reboot, and with persisted tasks (§ 2) a
finished task can outlive its file — and the view then says the output
is no longer available.

**Following.** While a view is open, the web subscribes to the task's
output over the WebSocket; the server watches that one file and pushes
appended bytes as `{ offset, text }`, the same offset-delta shape the
streamed transcript text uses
([[streamed-text-rides-as-offset-deltas-on-the-rows-id]]). No file is
watched while nobody has it open.

**ANSI.** The output is plain text in practice: the command writes to a
file, not a terminal, so tools turn their colour off themselves — none
of the 93 shell output files on the machine on 2026-09-28 held an escape
sequence or a bare `\r`. A command that forces colour (`FORCE_COLOR`,
`--color=always`) can still put them there, so as a safety net escape
sequences are stripped and a `\r` without `\n` replaces the line it
returns to. Colour is neither rendered nor forced
([[background-shell-output-is-not-forced-into-colour]]).

## 5. Where the artboards and this spec differ

- **Stop in the list.** 26e moves a stopped row to `ENDED` at once. Here
  it stays pending in `RUNNING` until the SDK confirms (§ 3).
- **Exit codes** exist only for shells and monitors (§ 2). A workflow or
  MCP row reads done or failed, never `exit N`.
- **"Output no longer available"** — 26b says the file was deleted when
  the machine restarted. That is one cause, not the only one; the copy
  says the file no longer exists.
- **Subagent ■** is not on the artboards; 25a's rows gain the same ■ the
  task rows have (§ 2).

## Out of scope

- Cloud sessions (`remote_agent`) — [[cloud-sessions-in-the-session]].
- Output of workflows and MCP tasks, and colour in shell output (§ 4).
- Terminal sessions.
- Persisting subagents.
- Telling a subagent's background tasks from the main loop's: whatever
  reaches the session's SDK stream is listed under the session.

## Tests

- Tracker: which `task_type`s it keeps; `ambient` dropped on both
  messages; a foreground `local_bash` hidden until `task_updated` moves
  it to the background, and never shown if it ends first; Bash vs
  Monitor from the launching call; each of the three ways a task ends;
  every running task ending when the CLI process exits; the exit code
  read off the output file's last line, and absent without it.
- Persistence: tasks survive a restart, and a task stored as running is
  ended without a status on load.
- `working` while only a background task runs, and the waiting label's
  wording rules (26d): order, the two-term cap, dropped count of one,
  mixed kinds.
- Stop route: `404`, `409`, `204`, that it calls `stopTask`, and that it
  takes a subagent's task id too.
- Output route: a tail cut to a line start, `410` for a missing file,
  and that no request reaches a path the tracker did not record.
- ANSI stripping and `\r` handling.
