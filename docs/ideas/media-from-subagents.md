---
id: media-from-subagents
title: Show subagents' own images in a session's Media
type: idea
status: backlog
domain: web
related:
  - 2026-10-09-session-media-design
  - 2026-09-22-subagent-transcript-panel-design
tags:
  - images
  - subagents
---
# Show subagents' own images in a session's Media

A session's Media (spec [[2026-10-09-session-media-design]]) lists only what
reaches the main transcript. A subagent's tool images, browser screenshots
especially, stay in its own transcript, and the main session sees only the
subagent's final report.

The first version leaves them out on purpose to keep it simple. When a
screenshot matters, the main agent usually names its path in a reply, and the
path makes it an item anyway.

If that proves too thin in practice, the media list could also read each
subagent's transcript (`SubagentTranscripts`). It would then tag every item
with the subagent that produced it and put those items under the same
"Hide tool images" switch.
