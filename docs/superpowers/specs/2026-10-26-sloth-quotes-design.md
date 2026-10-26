---
id: 2026-10-26-sloth-quotes-design
title: The floating sloth tumbles, and says a space quote when the pointer rests on it
type: spec
status: done
domain: map
related:
  - why-orbital
tags:
  - map
  - easter-egg
---
# The floating sloth tumbles, and says a space quote when the pointer rests on it

**Status: done**, agreed in conversation 2026-10-26 from issue #155 and built
the same day.

## Problem

The sloth that drifts across the planet map is a quiet easter egg with
nothing to find in it. Issue #155 asks for a speech bubble near its head
with a pop-culture line from space — "Open the pod bay doors, HAL",
"Don't Panic", "That's no moon".

## Behaviour

- Besides its drift and its bob, the sloth turns slowly round, the way
  anything adrift in zero g does. The turn has its own period, out of step
  with the drift's, so each lap of its path finds it facing another way.
- Resting the pointer on the sloth for a moment (the header tooltips' delay)
  stops it — drift, bob and turn all hold — and a bubble rises above it with
  one line.
- Moving the pointer away takes the bubble down and the sloth drifts on
  from where it stopped.
- Each time it speaks it picks a line at random, never the one shown last.
- The bubble carries the line alone, not where it is from: the fun is in
  recognising it, and a source would turn the line into a caption.
- The sprite is small and moving, so the pointer counts as on it a few
  pixels outside the image.

The bubble is the app's floating tooltip card (canvas 2d), carrying the line
where the card puts its mono name.

### The sloth never takes the pointer

The sloth drifts over the map, planets included. It stays transparent to the
pointer, so a planet under it can still be hovered and clicked; whether the
pointer rests on the sloth is worked out from the pointer's own moves over
the open map. That also means a sloth drifting under a pointer that is
standing still never starts talking, and one drifting under a panel cannot be
found through it.

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
- **What an existing user notices after updating:** the sloth turning
  slowly as it drifts; the quotes only if they rest the pointer on it.
- **What can be set:** nothing. A switch for an easter egg would cost more
  than the egg.
- **Planets only.** The sloth lives on the Planets map; the Desk theme has
  never had one and does not get one.
- **The website gets it too.** The site's map demo renders the same map, so
  a visitor can find the sloth there.

## Phone

Left out on purpose. The sloth lives only on the desktop's planet map, and
a phone has no hover to find it with.
