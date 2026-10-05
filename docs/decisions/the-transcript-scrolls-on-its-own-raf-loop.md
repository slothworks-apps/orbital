---
id: the-transcript-scrolls-on-its-own-raf-loop
title: The transcript scrolls on its own rAF loop
type: adr
status: in-force
domain: web
related:
  - the-zoom-buttons-ease-in-log-space
tags:
  - transcript
  - motion
---
# The transcript scrolls on its own rAF loop

A new message used to arrive with `el.scrollTop = el.scrollHeight`. Messages
reach the store as whole blocks — there is no token-level streaming — so every
arrival moved the view by tens to hundreds of pixels in a single frame. The
obvious fix is `el.scrollTo({ top, behavior: 'smooth' })`. It does not work
here, for two reasons that are both about the transcript rather than about the
animation.

**The container reads its own scroll position to decide things.** Whether the
reader is near the bottom is what tells `Transcript` to follow a new message or
to leave a reader of scrollback alone, and it is kept up to date by a `scroll`
listener. A native smooth scroll fires that listener at every intermediate
position, and at every one of them the honest answer is "not at the bottom" —
the animation has not arrived yet. The container would therefore un-stick
itself halfway through its own scroll, and the *next* message would not
follow. The native API exposes no way to tell a scroll it caused from one the
user caused. `createScroller` does: `isAnimating()`, which the listener checks
before believing a position.

**The target moves while the scroll is running.** Another message can land, a
tool run can finish, an image can finish loading — each moves the bottom the
scroll was aiming at. A native smooth scroll cannot be retargeted; issuing a
second one restarts the easing from a standstill, which is visible.

So `panels/transcriptMotion.ts` owns a small `requestAnimationFrame` loop, the
same shape the map's camera moves already use (see
[[the-zoom-buttons-ease-in-log-space]]).

## Exponential decay, not a start/end/progress animation

The step is `approach(current, target, elapsed, halfLife)` — the remaining
distance decays by half every half-life. Two properties earn it the place:

- **Retargeting is free.** There is no stored start position to invalidate, so
  a bottom that moved mid-flight is absorbed on the next frame with nothing to
  restart and nothing to re-ease. The loop re-reads `scrollHeight` every frame
  and simply keeps heading at wherever the bottom is now.
- **It is frame-rate independent by construction.** Applying it twice over
  `n` ms lands exactly where applying it once over `2n` ms lands, so the scroll
  takes the same wall-clock time on a 30Hz display and a 144Hz one. A per-frame
  lerp does not have this property, and the bug it causes is invisible on the
  machine it was written on.

Decay never actually arrives, so the step snaps once the remainder falls below
half a pixel; without that the loop would burn frames forever on deltas nobody
can see.

## What stays instant

Easing is for following along, not for travelling. Three cases skip it:

- the first paint of a session, and every session switch — there is nothing
  along the way worth seeing;
- any distance greater than about one and a half viewports, which is the same
  case arriving by a different route (a backlog loading late, say);
- `prefers-reduced-motion`.

Prepend compensation after "Load older" is also instant, and for a different
reason again: it is not a move at all. It puts the reader back where they
already were, and animating a correction would turn a no-op into a lurch.

## The reader's own jump is timed

The jump back to the bottom (the indicator, ⌘↓, a send from above; spec
[[2026-10-04-transcript-jump-to-bottom-design]]) is travel the reader asked
for, so it is the one case that does travel. It runs on the same loop, under
the same `isAnimating()` flag, but as a timed ease-out (`jumpDurationMs`,
canvas `Feature - Jump to bottom` 43e) rather than decay: the reader started
it and should feel it arrive. It still re-reads the bottom every frame, so
rows landing mid-jump move the end and nothing restarts. A long jump lands
just short of the bottom first and eases the rest, which keeps the rule
above: nothing several screens long is animated.
