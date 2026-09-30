---
id: permission-waits-are-measured-by-the-runner-only
title: Permission-prompt waits are measured by the runner, for Orbital sessions only
type: adr
status: in-force
domain: stats
related:
  - 2026-09-30-human-wait-tools-design
  - 2026-09-20-session-stats-design
tags:
  - server
  - runner
---

# Permission-prompt waits are measured by the runner, for Orbital sessions only

## Context

Stats must keep human wait out of work time (spec
`2026-09-30-human-wait-tools-design`). Questions and plan approvals are
tool calls of their own, so the transcript times them in every session.
A permission prompt is not: its wait sits inside the prompted tool's
`tool_use` → `tool_result` gap, and the transcript records neither when
the prompt appeared nor when it was answered.

## Decision

Only Orbital-run sessions split a permission wait out of its tool. The
runner already parks the prompt in `canUseTool` and settles it when the
user answers, so it knows both ends; it records them in a
`permission_waits` table that `computeStats` reads beside the
transcript. Terminal sessions keep the `†` caveat: their local-tool time
is an upper bound, and their count line shows no permissions.

## Ruled out

- **A CLI hook in `~/.claude/settings.json`.** A hook can report that a
  prompt appeared; no hook event marks the moment it was answered. It
  would give a count at best, not a wait, and editing the user's global
  CLI config for a count is not worth it.
- **Inferring prompts from the transcript.** A rejected prompt leaves a
  denial as its `tool_result`; an approved one leaves nothing. A count
  built from that is partial in a way the reader cannot see, so it is
  not shown.
