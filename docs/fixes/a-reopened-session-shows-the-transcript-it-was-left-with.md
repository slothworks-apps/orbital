---
id: a-reopened-session-shows-the-transcript-it-was-left-with
title: A reopened session shows the transcript it was left with, and the map re-renders every body per event
status: backlog
type: fix
domain: web
related:
  - resource-usage-pass-2026-09-24
  - 2026-09-22-ws-reconnect-resync-design
  - a-reply-is-in-the-transcript-file-but-not-in-the-open-panel
tags:
  - web
  - transcript
  - space-map
---
# A reopened session shows the transcript it was left with

Finding 6 of [[resource-usage-pass-2026-09-24]], the one item of that audit
left open when it closed. Three things, one root: what the web store keeps
while a session is not selected.

- **A deselected session's transcript stays, and goes stale.** Transcripts of
  every session ever selected stay in the store for the app's lifetime. The
  `session:<id>` subscription follows the selection, but `historyLoaded[id]`
  stays true, so a session you come back to shows the messages it had when you
  left it, not the ones that arrived since. Not yet reproduced; if it is real,
  it is a correctness bug, not a memory one, and it is a candidate cause for
  [[a-reply-is-in-the-transcript-file-but-not-in-the-open-panel]].
- **Every sessions event re-renders every planet and moon.** `Planet` and
  `Moon` are not memoised.
- **Each WebSocket message commits separately.** Batching per animation frame
  would cut the commits during a busy turn.

## The job

Either drop a session's transcript from the store when it is deselected, or
clear `historyLoaded[id]` so the next selection refetches; then memoise the
map bodies and batch socket commits per frame, measuring before each.
