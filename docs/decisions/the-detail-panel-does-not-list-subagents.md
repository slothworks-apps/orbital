---
id: the-detail-panel-does-not-list-subagents
title: The detail panel does not list a session's subagents
type: adr
status: in-force
domain: web
related:
  - 2026-09-15-orbital-web
  - subagents-in-transcripts
  - the-panel-reads-its-agent-live-not-the-snapshot-it-opened-with
tags:
  - detail-panel
  - subagents
---
# The detail panel does not list a session's subagents

The detail panel header no longer carries a strip of chips, one per
subagent, reading `name · state`. It was part of the first cut of the
panel in the [[2026-09-15-orbital-web]] plan and never appeared on any
artboard; nobody agreed on it, it just survived.

## Why it went

A session that fans work out to four or five agents grew a header four
or five rows tall, on top of the title, the model row, the context gauge
and the stats row. That pushed the transcript, the thing the panel is
for, below the fold. The chips were also the least useful place for the
information: the map already draws every subagent as a moon around its
planet, with state in the moon's colour and pulse, and a moon opens the
subagent panel with the agent's own transcript.

## What carries the information now

- The map: moons around the planet, live.
- The subagent panel, opened from a moon.
- The transcript: the parser marks where a subagent was launched and
  where it reported back ([[subagents-in-transcripts]]).
- The `WAITING FOR AGENT` state line and its count, from
  `awaitingSubagentCount`, which the header keeps.

## If it comes back

Design it on the canvas first. A single collapsed count that expands on
hover, or a row inside the stats drilldown, are the shapes that would not
cost the transcript its height.
