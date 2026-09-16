---
id: retag-migration-motion
title: A retagged session walks to its new cluster, and the camera follows it
status: active
type: adr
domain: sessions
related:
  - one-tag-per-session
tags:
  - space-map
  - motion
---
# A retagged session walks to its new cluster, and the camera follows it

## The problem

Switching a session's tag in the detail panel moved its planet to the other
side of the map in one frame. `buildSceneModel` recomputes the whole layout
from scratch, so a retag does not just move one body: the session leaves one
cluster and joins another, both spirals renumber, and the cluster orbit radius
can change with them. Every affected planet, moon and cluster label cut
straight to its new place.

The result read as a glitch rather than a move — and worse, the planet you had
open in the detail panel was now somewhere off-screen, with nothing to say
where it went.

## The decision

**Bodies walk; they do not cut.** `transition.ts` gained a `PointTween` (two
scalar tweens on one duration and curve) and `usePointTween`. `Planet`, `Moon`
and the cluster labels drive their group position from it, so any layout
change — retagging, a session appearing, a status change resizing a cluster —
eases instead of jumping.

`BODY_MOVE_MS` is **700ms**, against the app's 420ms `STATE_TRANSITION_MS`. A
state change is a body changing appearance in place; a migration crosses a
large part of the map. At 420ms that trip still reads as a teleport with
motion blur, and the point of animating it at all is to let the eye follow
which planet went where.

**The camera follows the selected planet**, on the same duration and curve, so
the map and the view arrive together. Three constraints on that:

- **Only a planet that was already selected.** Selecting a different session
  is the user pointing at something they can evidently see; hauling the camera
  there would take the rest of the map away from them.
- **Only a real move** — `FOLLOW_MIN_DISTANCE`, 1.5 world units (a planet's
  radius is 1). A new session renumbers its cluster's spiral and nudges its
  neighbours by a fraction of a planet, and chasing those would leave the map
  twitching. A retag clears the threshold by an order of magnitude.
- **No zoom.** Explicitly asked for, and right: following a session should
  move the view, not reframe it. Whatever the user had zoomed to stays.

The camera lands the planet in the middle of the strip between the sidebar and
the detail panel (`centerOn`), not in the middle of the viewport — with the
450px panel open, the viewport centre is half underneath it.

## How, and why that way

**The JSX `position` prop renders the tween's CURRENT value, not `x`/`y`.**
R3F re-applies that prop on every re-render, and the re-render delivering a
new target arrives one frame BEFORE the tween starts — so rendering the target
would plant the body at its destination for a frame and yank it back. This is
the same hazard the `scale` prop already documents in `Planet`.

**The camera pan is `requestAnimationFrame` → `setCamera`, not a tween inside
`CameraRig`.** The camera state is what the HUD readout and every subsequent
gesture are computed from, so it has to actually BE at the new place when the
pan ends, not merely look like it. A per-frame `setCamera` is the same cost
profile as dragging the map, which already does exactly that. Easing inside
`CameraRig` instead would have added lag to every drag.

**Any gesture cancels the pan** — pointer down, wheel, the zoom buttons, fit.
A camera that keeps sliding under a hand already on the map is a fight.

Reduced motion is honoured throughout: `usePointTween` and the pan both snap
to the destination, via the same `prefersReducedMotion` path the rest of
`transition.ts` uses.

## What this is NOT

`Feature - Tag clusters.dc.html` (canvas 4a/4b) proposes a different map
altogether: bodies on damped springs to their tag's barycentre, repulsion
between bodies, a draggable clump, and a corner black hole. Its trade-off list
is where "re-tagging becomes a visible migration (body walks to the other
clump)" comes from, and that sentence is the behaviour implemented here — but
the spring simulation, the drag-the-clump interaction and the hole are **not**
built. The layout stays the deterministic golden-angle spiral in `layout.ts`;
only the motion between two of its states is animated.
