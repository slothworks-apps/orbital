---
id: show-every-long-running-hook
title: Show any hook that holds a session, not only Stop
status: done
type: idea
domain: server
related:
  - 2026-10-31-message-beats-stop-hook-design
  - a-message-waits-for-a-stop-hook
tags:
  - sessions
  - hooks
---
# Show any hook that holds a session, not only Stop

The runner already asks the SDK for hook events (`includeHookEvents`) and
receives `hook_started` and `hook_response` for every event — `PreToolUse`,
`PostToolUse`, `UserPromptSubmit`, `SessionStart`, `PreCompact`,
`SubagentStop` — but shows a live row only for the main loop's `Stop` hooks.
A slow hook of any other event leaves an Orbital session looking stuck:
working, with nothing streaming and nothing to say why.

The spec ruled the others out as short by nature, a row per tool call being
noise. The row already waits `STOP_HOOK_NOTICE_AFTER_MS` before it shows, so a
short hook never draws one; only a hook that really holds the session would.

What it would take:

- One live row for whatever hook holds the turn, named by its event and,
  where the event has one, its matcher or tool (`PreToolUse hook running ·
  Bash`); the SDK does not name the command.
- Cancel only on `Stop` hooks, where it skips the check after a finished
  answer. A hook of any other event runs inside the turn: interrupting it
  stops the turn, which is the Stop button's job, so its row has no action.
- A subagent's hooks: on the moon's row, or not at all.
- The phone draws the same row; it rides the same `live_notice`.
- Claude Design for the row with and without its action.
