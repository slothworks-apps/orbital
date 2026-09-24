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

- ~~**A deselected session's transcript stays, and goes stale.**~~ **Fixed
  2026-09-24**: this was the cause of
  [[a-reply-is-in-the-transcript-file-but-not-in-the-open-panel]]; `select()`
  now refetches and replaces the transcript on a return. The store still
  keeps every transcript ever selected for the app's lifetime, which is the
  memory half of this item.
- **Every sessions event re-renders every planet and moon.** `Planet` and
  `Moon` are not memoised.
- **Each WebSocket message commits separately.** Batching per animation frame
  would cut the commits during a busy turn.

## The job

Drop a session's transcript from the store when it is deselected (the
refetch on return already exists); then memoise the map bodies and batch
socket commits per frame, measuring before each.
