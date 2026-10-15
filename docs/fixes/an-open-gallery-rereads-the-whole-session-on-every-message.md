---
id: an-open-gallery-rereads-the-whole-session-on-every-message
title: An open media gallery rereads the whole session on every message
status: backlog
type: fix
domain: web
related:
  - 2026-10-13-session-media-more-design
  - 2026-10-09-session-media-design
tags:
  - images
  - performance
---
# An open media gallery rereads the whole session on every message

## What happens

While a session's glance popover or gallery is open, every settled message
asks `GET /api/sessions/:id/media` again (`useSessionMedia` with `watching`).
Each request:

- walks the whole presented transcript for candidates (`mediaCandidates`),
  now including every `Bash` command's text, scanned for image paths;
- `stat`s every `agent` and `written` candidate (`locateMedia`);
- lists the subagents directory and reads and parses every `agent-*.meta.json`
  (`subagentFiles`) before the stamped cache can say which subagents moved.

The same walk was there before subagent and written media; it now has more
candidates. On a long session with many subagents and a busy agent this is
work proportional to the whole session, done once per message.

## Why it is not fixed now

Requests are coalesced (`useMedia.load`: one in flight per session, one
queued), it only runs while the gallery or popover is open, and nothing has
been measured as slow yet.

## What a fix would do

- Cache the main transcript's candidates under its file stamp, as
  `SubagentMedia` does for each subagent, so only `stat`s run per request.
- Stamp the subagents directory and skip `subagentFiles` when it has not
  changed; or keep each meta's `toolUseId` under the meta's own stamp.
- Measure first: a session with several hundred items is the case to time.
