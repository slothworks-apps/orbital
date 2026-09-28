---
id: the-context-gauge-is-a-traffic-light
title: The context gauge is green, amber, red — never the tag hue
status: in-force
type: adr
domain: map
related:
  - context-fill-arc
  - context-usage-has-one-source
  - 2026-09-24-state-colours-design
tags:
  - context
  - colour
---
# The context gauge is green, amber, red — never the tag hue

## The problem

Canvas 1i draws the context gauge in the session's tag hue until the fill
crosses the first threshold, then amber, then red. The detail panel's
context bar and its token read-out follow the same rule. In use, a bar in
the tag's cyan or violet does not read as "there is room" — it reads as
decoration, and the gauge only starts to mean anything once it turns
amber. Two sessions with the same fill looked different because their tags
differed.

## What was decided

Below the first threshold the gauge is a fixed green, the DONE state's
`oklch(84% .12 160)` (`--state-done`, canvas 24d), in `lib/usage.ts` as
`CONTEXT_OK_OKLCH`. Past the thresholds it stays canvas 1i's amber and red.
`contextLevelOklch(level)` is the one mapping from level to colour, and both
the map arc (`Planet.tsx`) and the detail panel's bar and read-out use it.

A token count against an unknown context window has no level, so the
detail panel's read-out keeps the session accent there. Green would claim
there is room when nothing knows that.

## Options ruled out

- **A new green matched to 1i's amber** (`oklch(80% .13 150)`). The owner
  chose the DONE green so that the app has one green.
- **Only the detail bar, arc keeps the tag hue.** Canvas 1i's acceptance
  asks that the arc and the bar change colour at the same values; they
  should change to the same colours as well.

## Consequences

This deviates from canvas 1i, which still says "≤ 50 % — tag hue". The
canvas should be updated to match.
