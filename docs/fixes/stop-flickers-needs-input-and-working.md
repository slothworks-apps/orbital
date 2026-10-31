---
id: stop-flickers-needs-input-and-working
title: Stop moves a session through needs_input, working and needs_input again
status: backlog
type: fix
domain: sessions
related:
  - 2026-10-31-message-beats-stop-hook-design
tags:
  - runner
  - status
---
# Stop moves a session through needs_input, working and needs_input again

## What happens

Pressing Stop on a running turn sets the session to `needs_input` at once
(`Runner.interrupt`). The CLI then streams the `[Request interrupted by user]`
marker as a main-loop `user` frame, which the runner reads as a turn starting
again and moves the session back to `working`; the interrupted turn's `result`
then settles it at `needs_input` for good. On the map the planet changes state
twice in a moment.

Seen while building `2026-10-31-message-beats-stop-hook-design`; it predates
that change and is not fixed there.

## Where to look

`server/src/runner/runner.ts`: the main-loop frame branch of the message pump
reopens the turn (`turnEnded = false`) for every frame. An interrupt marker
arriving after `interrupt()` should not count as a turn starting.
