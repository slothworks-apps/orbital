---
id: map-frames-are-drawn-by-a-refresh-ticker-under-one-cap
title: Map frames are drawn by a refresh ticker under one cap, not by timed invalidations
status: in-force
type: adr
domain: map
related:
  - 2026-09-24-map-frame-budget-design
  - resource-usage-pass-2026-09-24
tags:
  - web
  - map
  - performance
---
# Map frames are drawn by a refresh ticker under one cap, not by timed invalidations

## The problem

The map runs `frameloop="demand"` and draws at most N frames a second while
something moves ([[2026-09-24-map-frame-budget-design]]). Something has to
decide when the next frame is drawn.

The obvious way is a timer: when a frame ends with something still moving,
wait until 1000/N ms after it and call r3f's `invalidate()`. But
`invalidate()` only asks for a frame at the *next* display refresh. The timer
fires at the right moment, and the frame lands up to one refresh later. With
a 60 fps cap on a 60 Hz display, every frame slips by one refresh, and the map
runs at 30 fps.

## The decision

`FrameScheduler` (`web/src/map/frameSchedule.ts`) runs its own
`requestAnimationFrame` ticker while a frame is wanted. On each refresh it
checks whether the next frame is due. If it is, the ticker draws the frame
synchronously with r3f's `advance()`. If it is not, it waits for the next
refresh. A refresh that draws nothing costs a callback and a comparison.

The due time moves on a fixed grid (`nextDue`). A cap that does not divide the
refresh rate still averages out to the cap, for example 90 fps on a 120 Hz
display. The grid restarts after a gap. A refresh up to
`FRAME_TOLERANCE_MS` early still counts as due, so jitter does not halve a cap
that equals the refresh rate.

r3f still draws a frame of its own when a three.js prop changes or the canvas
resizes. Those frames pass through the same begin and end callbacks, so they
move the grid too.

## Also decided

- **One cap for everything.** The audit proposed full-rate transitions and a
  budget for ambient motion only. The spec caps both, and the scheduler does
  not tell them apart. Input requests (pointer drag, wheel, store changes) go
  under the cap as well: at the lowest focused cap, a request waits at most
  1000/`MAP_FPS_FOCUSED_MIN` ms.
- **Frames after a standstill start from rest.** The first frame after the map
  stood still or was paused advances by at most one frame at the default cap,
  not by the real gap (`frameDelta`). Otherwise a tween that a prop change has
  just started would finish in a single step.
