---
id: fit-flies-and-frames-what-the-bodies-draw
title: Fit flies, and frames what the bodies draw
type: adr
status: in-force
domain: web
related:
  - the-zoom-buttons-ease-in-log-space
  - the-zoom-range-is-wide-because-fit-is-the-way-back
  - counter-zoom-inflates-the-whole-moon-system
tags:
  - space-map
  - camera
---
# Fit flies, and frames what the bodies draw

Fit (the zoom stack's ⌖, ⌥F) cut straight to the fitted camera and framed
the bodies' CENTRE POINTS with a flat world-space padding. Both halves were
wrong, and they were wrong together: the cut hid that the frame was bad, and
the frame was bad in the exact corner the cut dropped you into — the hole
ending underneath the zoom stack.

## It flies

`useFlyTo` eases position and zoom as one move, on the same
`requestAnimationFrame`-into-`setCamera` shape as `usePanTo` and `useZoomTo`,
for the reason recorded in those: the camera is what the HUD readout and
every following gesture are computed from, so it has to actually BE there
when the run ends. Zoom interpolates in log space, as the buttons already do.

Fit is the one control that sets all three fields at once, which is why it
needs its own hook rather than a pan chased by a zoom: run separately they
arrive at different times and the map appears to swing. One duration
(`BODY_MOVE_MS`, the map's cross-the-whole-map duration) and one curve for
all three.

**The fit on page load still snaps.** A flight shows where a view moved
FROM, and on load there is nothing to have moved from — the default camera
is an implementation detail nobody has looked at, and flying out of it
would only advertise it.

## It frames drawn extent, not centres

Every body handed to `fitView` now carries the radius it draws at — a
planet's `footprint` (which already covers its moon system), the hole's
`HOLE_DROP_RADIUS` (its halo). Framing centres left whatever is drawn
around the outermost bodies hanging over the edge, and on the hole that is
almost all of it.

The radii are not constant in world space: `bodyZoomFactor` inflates bodies
as the camera zooms out, so the extent to frame depends on the zoom being
solved for. That makes it a fixed point, and `fitView` iterates — guess the
factor, solve the zoom, take the factor that zoom implies, repeat. The curve
is shallow and capped, so a handful of rounds lands a fraction of a pixel
from the true answer, and fit runs on a keystroke rather than per frame.

## The padding is screen-space and asymmetric

The old `FIT_PADDING` was 2 world units on every side. World units were the
wrong currency: the map's overlays are fixed-size chrome measured in pixels,
while the padding shrank with the zoom it was expressed in — the harder the
fit worked, the less it held back.

`FIT_MARGIN_PX` is per side, in CSS pixels, and deliberately uneven because
the chrome is: the zoom stack (with the error trigger above it) stands at the
strip's right edge, and the camera readout runs along the bottom. Left and
top carry breathing room only. The right value is the zoom column's width
plus its offset from the edge, which is what the bug was: fit put the hole
exactly where the buttons are.

This is the same shape of reasoning as the panel insets one layer out. Fit
frames into the strip between the sidebar and the detail panel, then keeps
the margins clear inside that strip; both are guards on the one camera move
that deliberately pushes content out to the edges.

## Ruled out

- **Widening the world padding.** It would have to be widened for the
  worst case (the hole at the bottom of the zoom range) and then every other
  fit pays for it — and it still could not know where the zoom stack is.
- **Counting the zoom column in `mapInsets`.** The insets are what panels
  COVER, and they also drive `centerOn`; the overlays are the fit's problem
  alone, and folding them in would quietly shift following a session too.
