---
id: subagents-in-transcripts
title: What a transcript says about subagents, and when
type: domain
status: active
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

## A running subagent is not in the transcript

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

## Where live subagent state does exist

Orbital's own sessions. The runner reads the SDK stream as it is produced, so
an `Agent` `tool_use` reaches it when the model emits it, not when the
subagent returns. That path is unaffected by everything above.

**Untested as of this writing** — no web session has run a subagent yet.
