---
id: the-timeline-is-built-on-the-server
title: The session timeline is built on the server from the whole transcript
status: in-force
type: adr
domain: sessions
related:
  - 2026-10-06-session-timeline-design
  - transcript-pages-older-history-on-scroll
  - the-phone-tunnels-the-api-behind-an-allowlist
tags:
  - timeline
  - transcript
---
# The session timeline is built on the server from the whole transcript

## Context

The timeline ([[2026-10-06-session-timeline-design]]) lists a session's
prompts, decisions, branches, commits and compactions. It is wanted
most in long sessions, and those are the sessions whose transcript the
client holds only in part: older history pages in on scroll
([[transcript-pages-older-history-on-scroll]]).

## Decision

The server builds the timeline from the session's full parsed message
list (`presentTranscript`, cached per file stamp), joins the subagents,
background tasks, harness and reader notes it already holds, and serves
it at `GET /api/sessions/:id/timeline`.

## Alternatives

- **Derive it in the client from the store's messages.** No new route,
  but a long session's beginning is missing until the user scrolls back
  through it — the opposite of what the timeline is for.
- **Extend the stats per-turn timeline.** It already segments turns,
  but it is built for metrics, re-parses per request and sits behind
  the stats switch. Its segmentation is reused as code instead.

## Consequences

- The phone gets the timeline through one allowlisted route, with no
  logic of its own.
- Jumping to an old event needs the client to page history in up to the
  anchor (`revealMessage`), since the timeline knows anchors the client
  has not loaded.
