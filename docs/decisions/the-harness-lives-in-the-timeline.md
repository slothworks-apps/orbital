---
id: the-harness-lives-in-the-timeline
title: The harness lives in the timeline instead of its own side-slot panel
status: in-force
type: adr
domain: sessions
related:
  - 2026-10-06-harness-in-the-timeline-design
  - 2026-10-06-session-timeline-design
  - 2026-10-02-harness-redesign-design
tags:
  - harness
  - timeline
---
# The harness lives in the timeline instead of its own side-slot panel

## Context

The session timeline ([[2026-10-06-session-timeline-design]]) lays a
harness's steps in as sections. The harness panel shows the same steps
as a checklist with records. Both want the one side slot, and the user
flips between them to connect a step's decisions with what happened
inside it.

## Decision

The timeline is the harness's home. Step sections carry the checklist's
markers, the active step's instructions and a done step's record; a
harness bar under the timeline's head holds progress and controls. The
separate harness panel goes. The step diff, the start view and the full
window stay their own surfaces, opened from the timeline.

## Alternatives

- **Keep both panels and link them.** Two places to look is the
  problem being solved.
- **Put the timeline inside the harness panel.** Most sessions have no
  harness, and they need the timeline as much.

## Consequences

- With `harness_enabled` off, the timeline simply has no harness; the
  experimental switch keeps its meaning.
- The phone can follow and steer a harness through the timeline sheet,
  which it could not before.
