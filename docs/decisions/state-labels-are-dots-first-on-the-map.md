---
id: state-labels-are-dots-first-on-the-map
title: State labels on the map are dots first, with the word as a setting
type: adr
status: in-force
domain: map
related:
  - 2026-09-24-state-colours-design
  - what-a-session-waits-for-is-a-label
tags:
  - web
  - map
---

# State labels on the map are dots first, with the word as a setting

## Context

Colour-coding the state labels (spec [[2026-09-24-state-colours-design]])
came back from Claude Design with two map treatments: pills that always spell
the state out (24a) and pills that rest as a coloured dot and spell it out on
hover (24e).

## Decision

Both ship. Dot-first is the default; Settings → Appearance lets the user
switch the map to always-spelled-out pills.

NEEDS INPUT collapses to its dot like every other state. It was considered
keeping it spelled out as the one state that blocks on the human; rejected, to
keep the map calm as the design intends — the breathing amber dot and the
summary line's `N NEEDS INPUT` carry it.

## Consequences

- With seven busy sessions the map shows seven dots instead of seven words,
  and pills stop colliding with neighbouring planets.
- The dot mapping has to be learned; the summary line, sidebar and detail chip
  still spell every state out, and that is where it is learned.
- Each state needs a dot in dot mode, including INTERRUPTED and DONE, which
  have none in label mode.
- Tag hues and state colours can coincide; shape (solid/hollow, breathing/
  pulsing/steady) keeps the states apart.
