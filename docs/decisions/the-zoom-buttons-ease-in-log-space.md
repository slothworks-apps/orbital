---
id: the-zoom-buttons-ease-in-log-space
title: The zoom buttons ease in log space
type: adr
status: in-force
domain: web
related:
  - separation-follows-the-counter-zoom-curve
tags:
  - space-map
  - camera
---
# The zoom buttons ease in log space

The map's `+` and `-` buttons cut straight to the new zoom, while every
other camera move on the map glides. `useZoomTo` now eases them, built on
the same `requestAnimationFrame`-into-`setCamera` shape as `usePanTo` —
and for the same reason recorded there: the zoom is what the HUD readout
and every following gesture are computed from, so it has to actually BE
there when the run ends, not merely look like it.

**Interpolated in log space, not linearly.** Zoom is a multiplicative
quantity — `zoomFromWheel` already treats it that way, which is why one
wheel notch means the same relative change at either end of the range. A
linear ramp from `MIN_ZOOM` to `MIN_ZOOM + ZOOM_STEP` doubles the map in
the first half of the run and adds a third in the second, so it reads as
a lurch that settles. A log ramp covers the same proportion of the change
in every frame. The endpoints are identical either way; only the path
between them differs.

**A second press extends the run rather than restarting it.** The target
accumulates from where the run is headed, not from where the animation
currently stands — aiming each press one step past the middle of the last
one would make a held button crawl.

Cancellation follows `usePanTo`'s contract: a pointer or wheel gesture
abandons the run where it stands. `cancelCameraMotion` cancels both runs
together; the buttons themselves cancel only the pan, since the zoom run
is the one being extended.

With the buttons off it, `applyZoom` had no callers left and was deleted
along with its tests. `clampZoom` — the part that was load-bearing — is
still where it was.
