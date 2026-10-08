---
id: 2026-10-08-kept-shells-design
title: A shell left running does not keep a session working
status: active
type: spec
domain: sessions
related:
  - 2026-09-28-background-tasks-design
  - what-a-session-waits-for-is-a-label
  - 2026-09-30-session-instructions-design
  - 2026-10-08-release-roadmap
tags:
  - runner
  - background-tasks
  - harness
---
# A shell left running does not keep a session working

## Problem

Since [[2026-09-28-background-tasks-design]] § "Working while a task runs",
every running background task keeps its session `working` after the turn
is over, shells included. That was meant for a shell the agent waits on (a
test suite run in the background, whose end re-invokes the agent). But
agents also leave shells running on purpose — a dev server, a watcher —
and then the session looks busy for as long as the server runs, while the
agent is done and waits for nothing. The map no longer says which sessions
have finished, which is the one thing it is for.

The SDK cannot tell the two apart: both are `local_bash` tasks started by
`Bash` with `run_in_background: true`, with the same events.

## Behaviour

1. **The agent says which it is.** Every background shell an Orbital
   session starts carries its intent at the start of the `Bash` call's
   `description`: `[wait]` when the agent waits for it to finish, `[keep]`
   when it is left running (a server, a watcher, anything not expected to
   end on its own).
2. **Orbital enforces it.** A `PreToolUse` hook, passed to `query()` in
   `Runner.start` (the SDK's programmatic `hooks` option: it lives in
   Orbital's process, applies only to sessions Orbital runs, and writes
   nothing to any settings file), matches `Bash`. A call with
   `run_in_background: true` and neither marker is denied, with a reason
   telling the agent to repeat the call with `[wait]` or `[keep]` and what
   each means. A foreground `Bash`, and every other tool, passes
   untouched. It applies to subagents' calls too, as they run in the same
   query.
3. **The session instructions say it up front**, so a denial is the
   exception: one line in the appendix Orbital composes
   ([[2026-09-30-session-instructions-design]]), always on — it is not
   one of the switchable tips, since the hook enforces it either way.
4. **Only `[wait]` keeps the session working.** The tracker records each
   shell task's intent from the `description` of the `Bash` call its
   `tool_use_id` names. `hasLiveBackgroundWork` counts running subagents,
   workflows, monitors, MCP tasks and `[wait]` shells; a `[keep]` shell
   does not hold `working`. A shell with no recorded intent (no matching
   call, or an older session) counts as `[wait]`, as today.
5. **A kept shell stays visible.** It is still listed with the session's
   background tasks, can be read and stopped as before, and the label of
   what a session waits for (`awaitedWork`) counts only what holds
   `working`. The marker is cut from the description wherever it is shown.
   No new visual in this change; a planet-level hint for "a shell is
   running" is left to Claude Design if it turns out to be missed.

If a `[wait]` shell ends, the CLI re-invokes the agent and the session is
`working` again, as today. If a `[keep]` shell ends on its own, the CLI
re-invokes the agent too; that is the CLI's behaviour and is not changed.

## Phone

Reaches the phone with no work of its own: `working` is decided on the Mac
(`Runner`), and the phone's state words read `backgroundTasks` through the
same shape. The shape carries each task's intent so the phone's and the
desktop's labels agree.

## Testing

- The hook: a background `Bash` without a marker is denied with the
  reason; with either marker, and a foreground `Bash`, it is allowed.
- The intent parser: marker at the start, case, surrounding whitespace,
  a marker elsewhere in the text not counting.
- `hasLiveBackgroundWork` / the runner's busy rule: a `[keep]` shell alone
  leaves the session `needs_input` after the turn; a `[wait]` shell keeps
  it `working`; an unknown intent keeps it `working`.
- `awaitedWork` ignores `[keep]` shells.
