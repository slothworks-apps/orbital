---
id: the-subagent-panel-takes-the-session-slot-on-narrow-windows
title: Below about 1010 px the subagent panel should take the session panel's slot (canvas 11d)
status: backlog
type: idea
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
  - panel-pair-ceiling-includes-the-gutter
  - 2026-09-23-detached-session-windows-design
tags:
  - web
  - subagents
  - layout
---
# The subagent panel takes the session slot on narrow windows

Deferred from [[2026-09-22-subagent-transcript-panel-design]] when that spec
closed. Two panel minimums plus gutters need 756 px, which breaks the 75 %
ceiling below roughly 1010 px of viewport; today the panels simply sit tight
against the ceiling there.

Canvas artboard **11d** designs the answer: a second layout mode where the
agent panel takes the session panel's slot, its header gains a `↖ <session>`
back control, and closing the agent restores the session rather than the map.
The detached window already does the equivalent swap below the pair minimum
([[2026-09-23-detached-session-windows-design]]); the docked pair does not.

It was left out of v1 as the largest single layout item, and the target
machine rarely reaches that width. When it is built, 11d is the spec.
