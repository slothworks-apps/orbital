---
id: subagents-in-transcripts
title: What a transcript says about subagents, and when
type: domain
status: in-force
domain: subagents
related:
  - 2026-09-16-subagents-everywhere-design
  - 2026-09-15-orbital-design
  - 2026-09-20-session-stats-design
  - 2026-09-22-subagent-transcript-panel-design
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

## Sidechain entries are in their own files, not the session transcript

Measured 2026-09-21 while building `computeStats`, by scanning every `.jsonl`
under `~/.claude/projects`: **427 session transcripts contain zero
`"isSidechain":true` lines.** All 97 840 of them sit in 926 files under
`<project>/<session-id>/subagents/agent-<id>.jsonl`, beside an
`agent-<id>.meta.json` naming the `agentType`, `description`, `toolUseId`,
`spawnDepth` and `model`.

A sidechain entry carries the parent's `sessionId` and an extra `agentId`, so
the two sides can be joined — through the meta file's `toolUseId` for the
`Agent` `tool_use` it came from.

This contradicts the assumption in `2026-09-20-session-stats-design`
(§ Source data) that "subagent traffic sits in the same file with
`isSidechain: true`", which was written from the older layout. Consequences
for anything reading subagent usage:

- `computeStats` handles sidechain entries wherever they arrive — it keys on
  `isSidechain`, not on which file a line came from — so feeding it a
  concatenation of a session and its `subagents/*.jsonl` works unchanged.
- Feeding it the session transcript alone, which is what the indexer does
  today, yields `subagentTokens: 0` on every current-CLI session. The
  subagent's wall time is still counted: it comes from the parent's `Agent`
  tool run, which is in the main file.

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

## A subagent's own conversation is a separate stream, opt-in and pre-joined

Everything above is about the parent's own transcript. A subagent's prose and
thinking — what it said, not just which tools it called — travel on a
different channel, and only if asked for.

`forwardSubagentText` (`@anthropic-ai/claude-agent-sdk`'s own `query()`
options, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) is built for
exactly this. Its own doc comment: *"When true, the full subagent
conversation is forwarded so consumers can render a nested transcript."*
Without it, only `tool_use`/`tool_result` blocks from a subagent ever cross
the stream at all — no text, no thinking. Orbital turns it on in
`Runner.start()` (`server/src/runner/runner.ts`).

Once it is on, a subagent's frames need to be told apart from the parent's
own — otherwise the whole nested conversation floods `session:<id>`, not the
one summary line a `tool_result` used to carry. The field that tells them
apart is `parent_tool_use_id`, set on every frame that came from inside an
`Agent` call to that call's own `tool_use` id — the same id
`SubagentInfo.toolUseId` already carries, from `task_started.tool_use_id`.
The join between "which agent's transcript is this" and "which moon does
this agent have" needs no new key: `pump()` routes on
`msg.parent_tool_use_id` directly (`runner.ts`, the `assistant`/`user` frame
handling), and the value it routes on is already the value the moon-to-panel
join uses everywhere else.

**A nested agent — one spawned by another agent, not by the parent — carries
the INNER `Agent` tool_use id**, i.e. the id of the call that spawned it, not
the outer agent's own id. This falls out of the definition above with no
extra handling: an agent's `parent_tool_use_id` is always the `tool_use` id
of whatever `Agent` call started it, however many levels down that call
itself was. So a depth-2 agent's frames land in a buffer keyed by the
depth-2 `Agent` call's own id, never mixed into its parent agent's buffer,
and the outer agent's own buffer sees only the ordinary `tool_use`/
`tool_result` pair for the nested `Agent` call — nothing about routing needs
to know it is looking at depth 2 versus depth 1.

## The on-disk fallback nobody reads yet

Every subagent's own conversation is also written to disk, incrementally, at
`<session-id>/subagents/agent-<agentId>.jsonl`, independently of whether
anything is watching the live stream. This branch does not read these files
— the live stream (above) gives the same content with no watcher and no
meta-file join — but it is the fallback if `forwardSubagentText` ever stops
being honoured by a future CLI, the same way `Task`-vs-`Agent` detection
above already needed a fallback once.

Measured 2026-09-22, directly against the files rather than taken on faith:
one session directory
(`~/.claude/projects/-Users-tomin-Projects-acme-acme-mobile-app/83e11349-9a79-47c2-9333-14f819646ee1/subagents/`)
holds exactly 15 agent files. Across all 15, the file's birthtime matches its
first entry's `timestamp` and its mtime matches its last entry's `timestamp`
(within seconds, both ways, on every file) — confirming the file is created
when the agent **starts** and appended to as it works, not written once at
the end. The entry-to-entry spread (last minus first) ranges from 5.3s to
114.3s across the 15 files, with `agent-a3c5e4359509cbe31.jsonl` the widest
at 114.3s. A second, wider pass over every `agent-*.jsonl` under this
machine's whole `~/.claude/projects` tree (**1 000** files) confirms the same
birthtime/mtime pattern generally, not just in that one session: mtime
matches the last entry's timestamp in all 1 000, birthtime matches the first
entry's timestamp in 995 of 1 000 (the 5 exceptions not investigated
further — a file touched by something other than normal append, or one
whose first line was itself written late, would each produce this). Spreads
go far wider than the 15-file sample's 114.3s ceiling — the single widest
file in the full tree spans roughly 26.5 hours between its first and last
entry. The 15-file, one-session sample above is the convenient, fully-
enumerable slice; the full-tree pass is what confirms it generalises.
