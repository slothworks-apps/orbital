---
id: task-output-is-followed-by-polling
title: A background task's output file is followed by polling, not fs.watch
type: adr
status: in-force
domain: sessions
related:
  - 2026-09-28-background-tasks-design
  - recursive-fs-watch-instead-of-chokidar
  - streamed-text-rides-as-offset-deltas-on-the-rows-id
tags:
  - background-tasks
  - server
  - watcher
---

# A background task's output file is followed by polling, not fs.watch

## Context

The output view ([[2026-09-28-background-tasks-design]] § 4) follows a
shell's output file while it is open: the server pushes the appended bytes
on `task-output:<sessionId>:<taskId>`. The file lives in the CLI's
`/private/tmp/claude-<uid>/…/tasks/` directory, beside one file per task
the session ever ran.

## Options

1. **`fs.watch` on the file.** On macOS that is a kqueue descriptor, and a
   write landing right as the watch registers can be missed — the race
   `TranscriptTail` documents, and the reason it watches its directory.
2. **`fs.watch` on the tasks directory, filtered by name.** Avoids the race
   ([[recursive-fs-watch-instead-of-chokidar]]), but fires for every other
   task's writes too, and still needs a fallback when the watch errors.
3. **Poll the file's size** every `TASK_OUTPUT_POLL_MS` while a view has it
   open.

## Decision

Option 3 (`OutputFollower` in `server/src/files/taskOutput.ts`). One `stat`
per open view per tick holds no descriptor, cannot miss a write, and
notices a deleted file the same way it notices a grown one. Nothing is
polled while no view is open. The latency is at most one tick, which a
log view does not feel.

Each delta is `{ offset, text }` with `offset` the byte offset of `text`'s
first byte. A read that ends inside a multi-byte character leaves that
character's bytes for the next read, so the text is never decoded in
halves and the offsets stay exact byte positions. A file that grows by
more than `OUTPUT_TAIL_BYTES` between ticks is skipped forward to its last
`OUTPUT_TAIL_BYTES`; the view keeps only its last lines anyway.

## Consequences

- A follower starts at the file's end; the client reads the tail over REST
  after subscribing and drops what of a delta lies below that tail's `end`.
- If the output path is not known yet when a view subscribes (the launch's
  `tool_result` has not arrived), following starts as soon as it is.
