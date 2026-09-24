---
id: 2026-09-24-streaming-output-design
title: Streaming output — an answer appears as it is written, not when it is done
type: spec
status: done
domain: transcript
related:
  - feature-parity-with-the-claude-code-cli
  - streamed-text-rides-as-offset-deltas-on-the-rows-id
  - thinking-is-its-own-chatmessage-role
  - 2026-09-22-subagent-transcript-panel-design
  - the-transcript-scrolls-on-its-own-raf-loop
tags:
  - server
  - web
  - transcript
  - sdk
---

# Streaming output

The "Streaming output" row of [[feature-parity-with-the-claude-code-cli]]:
messages land whole, so a long answer reads as a hang. The CLI shows text as
it is generated; Orbital showed nothing until the block was finished.

Written 2026-09-24 without the interactive design loop: the decisions below
were made under the assumptions stated, and the person who asked for the
work should read them as proposals that shipped, not as agreements.

## 1. Behaviour

- **Prose and thinking of the main loop stream.** While the CLI generates
  an assistant message, its text blocks and thinking blocks appear in the
  transcript as they are written. Canvas 1b already draws the streaming
  assistant turn — the plain text with the blinking caret after the last
  glyph — and that is what fills in; nothing new is drawn.
- **Tool calls do not stream.** A `tool_use` block's input arrives as JSON
  fragments that are not readable until complete. Its row appears when the
  block is complete, as today.
- **Subagents do not stream, yet.** Frames with `parent_tool_use_id` set are
  left to the subagent panel's own feed, which stays whole-message. The
  panel can take the same events later; nothing here forecloses it.
- **The finished block replaces the streamed one in place.** The SDK sends
  the complete assistant message after the stream, one frame per completed
  block. That frame takes over the row the stream was filling — same
  position, same row id — so nothing jumps, re-animates or duplicates. On a
  reload the transcript comes from the file and never saw a partial row.
- **A partial row is never an orphan.** When the turn ends, any row still
  marked partial is simply kept as final: its text is what was streamed, and
  the file has the same text.
- **Joining mid-stream is tolerated, not perfect.** A tab that subscribes
  while a block is half written sees the rest of it grow and then the
  complete block replace it. It does not receive the head separately.

## 2. The wire

One new event on `session:<id>`:

```
{ event: 'delta', id, role: 'assistant' | 'thinking', offset, text, model? }
```

- `id` is the row's id, minted by the server when the block starts. The
  complete block, when it arrives as an ordinary `message` event, carries
  the SAME id — that is how the client knows what to replace.
- `offset` is where `text` goes in the row: the length of everything sent
  for this row before it. A delta whose offset is behind the row is a
  duplicate and is ignored; one that is ahead means the head was missed
  (joined mid-stream) and is still appended.
- `model` rides on every delta so a row created from a delta can show its
  model chip and divider like a finished one.

`ChatMessage` gains `partial?: true`, set on a row that is still being
streamed and cleared when the complete block replaces it or the turn ends.

Deltas are **coalesced on the server** per row, `STREAM_FLUSH_MS` apart,
and flushed at once when the block stops or when any complete message is
about to be published — so the order on the wire is always: every delta of a
block, then the block. The wire and the transcript re-render at most a few
times a second per session, whatever the token rate.

## 3. Server

`Runner.start` passes `includePartialMessages: true`. In `pump()`, a
`stream_event` frame of the main loop goes to the session's stream state:

- `message_start` opens a stream for `event.message.id` (and remembers its
  model), and counts as the turn's first frame for the status edge, exactly
  as an assistant frame does today.
- `content_block_start` of a `text` or `thinking` block mints a row id and
  an empty row for that index. Other block types get no row.
- `content_block_delta` with `text_delta` or `thinking_delta` appends to the
  row and to its pending delta.
- `content_block_stop` flushes the row's pending delta.
- `message_stop` flushes everything; the rows stay until claimed.

When the complete assistant frame arrives, the runner flushes first, then
converts it with an id resolver: a `text` or `thinking` block whose text
equals an unclaimed stream row's text takes that row's id. Text equality,
not block order — the deltas concatenate to the final text exactly, and the
SDK's one-frame-per-block promise is not something to lean on. A block with
no matching row gets a fresh id, as today.

## 4. Web

`applySessionEvent`:

- `delta` — find the row by id. Absent: append a new partial row with the
  delta's text, role, model and a timestamp of now. Present: append the
  text when the offset is where the row ends; ignore it when the offset is
  behind. The next expected offset is kept in non-reactive bookkeeping, so
  a mid-stream join (offset ahead of an absent row) still tracks.
- `message` whose id is already held — today's dedupe — now checks the held
  row: partial → replace it in place, final → drop the event (a twice-
  delivered final still dedupes).
- `turn_result` — clear `partial` on every row of the session that still has
  it.

`TranscriptView` needs nothing: rows are keyed by id, the caret already
sits on the last assistant row while the session works, and the transcript
already sticks to the bottom as rows grow. `ThinkingBlock` keeps its
collapsed default in the main panel (canvas 11b), so a streaming thinking
block shows as its label growing no wider — the label appearing at once is
the signal.

## 5. Tests

- Runner: a scripted stream (start, text block, two deltas, stop, complete
  frame) publishes deltas that concatenate to the block's text, before the
  complete `message`, and the message carries the row's id. A `tool_use`
  block streams nothing. A subagent's stream events publish nothing on
  `session:<id>`.
- Store: a delta creates a partial row; a following delta grows it; a
  repeated delta is ignored; the complete message replaces the partial row
  in place under the same id; a second copy of the complete message is
  dropped; `turn_result` finalises a leftover partial row.
