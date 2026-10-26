---
id: 2026-10-26-sloth-quotes-design
title: The floating sloth says a space quote when the pointer finds it
type: spec
status: done
domain: map
related:
  - why-orbital
tags:
  - map
  - easter-egg
---
# The floating sloth says a space quote when the pointer finds it

**Status: done**, agreed in conversation 2026-10-26 from issue #155 and built
the same day.

## Problem

The sloth that drifts across the planet map is a quiet easter egg with
nothing to find in it. Issue #155 asks for a speech bubble near its head
with a pop-culture line from space — "Open the pod bay doors, HAL",
"Don't Panic", "That's no moon".

## Behaviour

- Resting the pointer on the sloth stops it — the drift and the bob both
  hold — and a bubble rises above it with one line and, under it, where the
  line is from.
- Moving the pointer away takes the bubble down and the sloth drifts on
  from where it stopped.
- Each hover picks a line at random from `SLOTH_QUOTES`, never the one shown
  last.
- The sprite is small and moving, so its hover target is a few pixels
  larger than the image.

The bubble is the app's floating tooltip card (canvas 2d): the line where
the card puts its mono name, the source where it puts its sentence.

### Not on its own

The issue asks for the bubble to appear "from time to time randomly". It
does not: a bubble that pops up unasked pulls the eye, and motion on the map
never exists to do that (`why-orbital` → Nothing blinks). The sloth speaks
only when someone goes looking.

## Scope

- **Who it is for:** anyone who notices the sloth; it is a small reward for
  looking, not a feature anyone relies on.
- **Where it lives:** on by default. It changes nothing until the pointer
  lands on the sloth, so it costs no attention otherwise.
- **What an existing user notices after updating:** nothing, unless they
  hover the sloth.
- **What can be set:** nothing. A switch for an easter egg would cost more
  than the egg.

## Phone

Left out on purpose. The sloth lives only on the desktop's planet map, and
a phone has no hover to find it with.
