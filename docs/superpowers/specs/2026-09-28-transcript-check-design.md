---
id: 2026-09-28-transcript-check-design
title: The open transcript is checked against its file
type: spec
status: done
domain: web
related:
  - 2026-09-22-ws-reconnect-resync-design
  - a-reply-is-in-the-transcript-file-but-not-in-the-open-panel
  - the-tail-yields-to-the-runner
tags:
  - websocket
  - transcript
---

# The open transcript is checked against its file

## Why

The open chat still stalls now and then: the panel stops showing new
output, and ⌘R brings the missing messages back at once. So the transcript
file has them and the live path over `session:<id>` lost them. Two fixes
have closed known causes ([[2026-09-22-ws-reconnect-resync-design]],
[[a-reply-is-in-the-transcript-file-but-not-in-the-open-panel]]). The one
that is left has never been reproduced, and the socket leaves no evidence
behind. Reported again on 2026-09-28.

This does two things: it repairs the panel without a reload, and each repair
writes a log entry that records the socket's state at that moment.

## Behaviour

**The check.** While a session's transcript is on screen (the docked detail
panel's selection, or a detached window's session), the client reads the
tail of its transcript file every `TRANSCRIPT_CHECK_MS`
(`GET /api/sessions/:id/messages?limit=TRANSCRIPT_CHECK_PAGE`). It skips the
check while the document is hidden, while the socket is not open (the
reconnect's own catch-up reloads then), before the history is seated, and
while the previous check is still in flight. The server caches the parsed
file by its stamp, so an unchanged file costs nothing to read again.

**What counts as missing.** The file's newest `assistant`, `tool_use` or
`tool_result` row must be one the panel holds. Ids do not help here: a live
row carries the runner's id and the file's copy carries a transcript uuid.
So tool rows match on `toolUseId`, and assistant rows on their trimmed
text. A partial (still streaming) row does not count as holding the
finished block. User turns, thinking and notices are not checked, because
the two paths do not shape them alike: a slash command or an image-only
turn is the optimistic bubble on one side and something else in the file.
Across 25 real transcripts every row of the three checked roles matched,
4892 of 4892.

**Two checks, not one.** The CLI can write a row to the file a moment
before the same row reaches the socket. So a first miss is only
remembered. The panel is reloaded when the row remembered last time is
still not held, whatever the tail says now. Comparing the current tail
instead would never catch a busy session, whose tail moves on every check.

**The repair.** It is the same transcript swap the reconnect catch-up
makes. The file's history replaces the held transcript, and an optimistic
turn the file has not echoed yet is kept. Pages loaded by scrolling up are
lost, as they are after a reconnect.

**The log.** Every repair posts a `transcript_gap` to the error log. It
carries the missing row's id, role and timestamp, how many rows the panel
held, the session's status, whether the window had focus, and the socket's
`diagnostics()` for the topic:

- its status;
- whether the client is subscribed;
- whether the server's last heartbeat names the topic;
- how long ago the topic last delivered a frame;
- how long ago the last heartbeat arrived.

**The heartbeat names its topics.** The hub's heartbeat frame now lists the
topics the hub actually holds that socket on, read from the topic sets.
That tells apart the two readings the fix document left open. If the server
no longer sends us the topic, `heldByServer` is false. If the server holds
the topic and nothing was published, `heldByServer` is true and
`lastFrameAgoMs` is long.

## Next

When a `transcript_gap` shows up in the log, read its `socket` context and
update [[a-reply-is-in-the-transcript-file-but-not-in-the-open-panel]] with
the cause it points at.
