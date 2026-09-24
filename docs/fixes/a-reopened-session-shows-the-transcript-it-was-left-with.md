---
id: a-reopened-session-shows-the-transcript-it-was-left-with
title: A reopened session shows the transcript it was left with, and the map re-renders every body per event
status: done
type: fix
domain: web
related:
  - resource-usage-pass-2026-09-24
  - 2026-09-22-ws-reconnect-resync-design
  - a-reply-is-in-the-transcript-file-but-not-in-the-open-panel
  - sessions-topic-events-land-once-per-frame
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

## Fixed 2026-09-24

- **Transcripts.** The store subscription that closes the agent panel on a
  selection change also drops `transcripts[id]` and `historyLoaded[id]` of
  the session left behind (`dropTranscript` in `web/src/store/store.ts`),
  unless the subagent panel still shows it. `select()` therefore always
  fetches a session coming back, and its "returning" merge is gone. An
  optimistic turn of the left session goes with its transcript; the file's
  echo is what the refetch finds. A history fetch that resolves after its
  session was left again is not seated.
- **Map bodies.** `Planet` and `Moon` are `React.memo`. The one prop that
  defeated it was `contextFill`, a fresh object per scene-model build;
  `useSceneModel` now hands an unchanged planet its previous fill object
  (`reuseContextFills`). On a 30-planet map with 6 moons, one sessions event
  went from 30 planet and 6 moon renders to 1 and 0.
- **Socket commits.** `sessions`-topic events from the socket land once per
  animation frame as one store write
  ([[sessions-topic-events-land-once-per-frame]]).
