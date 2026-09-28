---
id: background-shell-output-is-not-forced-into-colour
title: Background shell output is not forced into colour
type: adr
status: in-force
domain: sessions
related:
  - 2026-09-28-background-tasks-design
tags:
  - background-tasks
---

# Background shell output is not forced into colour

## Context

The background task list ([[2026-09-28-background-tasks-design]] § 4)
shows a shell's output from the file the CLI writes it to. That output
is plain text: the command writes to a file, not a terminal, so tools
switch their colour off. Tomin would have liked the colour in the view.

A spike on 2026-09-28 tried forcing it.

## What the spike found

- **Forcing works, invisibly.** An in-process `PreToolUse` hook that
  returns `updatedInput` with `FORCE_COLOR=1 CLICOLOR_FORCE=1` prefixed
  to a `run_in_background` `Bash` command runs the prefixed command, while
  the transcript and the model's own `tool_use` keep the original. Only
  tools that read those variables comply (Node tooling: vitest, eslint,
  npm); `git` and `ls` have their own switches.
- **The agent pays for it.** The CLI hands a file to the agent as is:
  neither `Read` nor `Bash` strips escape sequences. The server's own
  vitest run grew from 38 KB to 49 KB with 2,753 escape sequences, each
  several tokens — an estimated half again to double the tokens of every
  read of a test run's output, and agents read background output often.
- **There is no hook to hide it from the agent.** `PostToolUse` can
  replace a tool's output only for MCP tools (`updatedMCPToolOutput`), not
  for `Read` or `Bash`.

## Options

1. **Force colour on background shells** — colour in the view, the token
   cost above on the agent's side.
2. **Split the stream** — the hook wraps the command so a coloured copy
   goes to a file of Orbital's own and a stripped copy to the CLI's file.
   It changes how the command runs: the exit status crosses a pipe,
   output buffers differently, and stopping the task has to take the whole
   pipeline down. Fragile for a cosmetic gain.
3. **Leave the output as the command writes it.**

## Decision

Option 3. Nothing is forced and nothing is split. The output view
strips escape sequences, as a safety net for a command that forces
colour by itself, and does not render colour.

## Consequences

- The view reads like the agent's copy of the output, character for
  character, minus any escape codes.
- If colour is wanted later, option 1 is a small, proven change and could
  sit behind a setting; option 2 is where to look only if a way to split
  the stream without wrapping the command appears (e.g. an SDK hook that
  can rewrite `Read` / `Bash` output).
