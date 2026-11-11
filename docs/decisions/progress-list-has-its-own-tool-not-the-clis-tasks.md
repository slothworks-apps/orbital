---
id: progress-list-has-its-own-tool-not-the-clis-tasks
title: The progress list has its own MCP tool, not the CLI's TaskCreate and TaskUpdate
type: adr
status: in-force
domain: sessions
related:
  - 2026-11-09-progress-list-design
tags:
  - progress-list
---
# The progress list has its own MCP tool, not the CLI's TaskCreate and TaskUpdate

## Context

The Claude Code CLI already gives the agent a task list: `TaskCreate`
(subject, description) and `TaskUpdate` (status), which replaced
`TodoWrite`. Orbital could show those from the transcript. That would need
no new tool, and it would work in terminal sessions too.

But that list is the agent's own bookkeeping. Agents create it rarely (8
sessions in months of transcripts, as of 2026-11-09). Its shape is
per-item calls with ids, and it carries no reason when the plan changes. The
progress list is meant for the user to follow. The agent writes the whole
plan up front, and every added or dropped item must come with a reason the
user sees.

## Decision

- The progress list is written through an MCP tool Orbital gives its own
  sessions. Every call carries the whole list, and a call that adds or
  drops items carries a reason.
- While a session has a progress list, the CLI's `TaskCreate` and
  `TaskUpdate` are disallowed in it, so the agent keeps one list.

## Consequences

- Terminal sessions have no progress list. Orbital cannot give them a
  tool. Showing their CLI tasks readably is a separate parity item.
- The tool's calls sit in the transcript like any tool call, so the list is
  rebuilt from the transcript without a table of its own.
- If the CLI's task tools later carry what the progress list needs, this
  can be revisited. The progress list's readouts would stay as they are,
  and only their source would change.
