---
id: the-zoom-range-is-wide-because-fit-is-the-way-back
title: The zoom range is wide because fit is the way back
type: adr
status: in-force
domain: map
related:
  - 2026-09-21-fit-honours-the-panels-design
  - counter-zoom-inflates-the-whole-moon-system
  - the-zoom-buttons-ease-in-log-space
  - planets-shrink-slower-than-the-map
tags:
  - space-map
  - camera
---

# The zoom range is wide because fit is the way back

`MIN_ZOOM`/`MAX_ZOOM` were `[20, 200]`. They are now `[5, 400]`.

The floor was the one that bit. Once fit started framing the strip between
the panels rather than the whole viewport
([[2026-09-21-fit-honours-the-panels-design]]), a real map — a few clusters
plus the history hole, with both panels open on a 1440px window — wanted a
zoom in the low teens. The clamp caught it, and a clamped fit overflows on
every side: the sessions went straight back under the panels, which is the
bug the insets exist to fix.

**Chosen: widen the range well past what that case needs, at both ends.**
The alternative was to lower the floor just far enough — to 10, say, which
covered the map in front of us. Rejected: it buys the same argument again
the next time someone's map grows, and it mistakes what the limits are for.

A zoom range does not have to keep anyone oriented here. Fit (⌖, ⌥F)
reframes the whole map from wherever the camera has been left, so
overshooting in either direction costs one keystroke. What a tight range
costs instead is a view the map genuinely needs and cannot reach.

## What moved with it

`FACTOR_MAX`, the cap on the counter-zoom curve, was the literal `1.7` —
which was the curve's own value at the *old* floor of 20. Left there, bodies
would have started shrinking linearly again across the whole newly-opened
bottom of the range, which is exactly where they can least afford it. It is
now derived: `(REFERENCE_ZOOM / MIN_ZOOM) ** FACTOR_K`, so the curve runs
uninterrupted to the bottom of whatever the range is, and the cap only ever
catches the arithmetic.

## The cost accepted

`FIT_PADDING` (2 world units) is what a body's drawn radius has to come out
of, because fit frames positions and not bodies. A big planet inflates to
~2.3 world units at the new cap, so below zoom ~7 it pokes out of the
padding. That is worth under two screen pixels — padding is measured in
world units and shrinks with the zoom it is measured in — and widening the
padding to cover it would cost every fit at every other zoom.
