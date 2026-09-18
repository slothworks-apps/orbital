---
id: planets-shrink-slower-than-the-map
title: Planets should shrink more slowly than the map does when zooming out
status: done
type: idea
domain: web
related:
  - map-ended-declutter
  - counter-zoom-inflates-the-whole-moon-system
tags:
  - space-map
  - camera
---
# Planets should shrink more slowly than the map does when zooming out

Zooming out is how you see the whole field, and it is exactly when a planet
stops being readable. A planet's on-screen size is strictly linear in camera
zoom today — the orthographic camera draws `worldUnits * zoom` pixels, and a
planet's world radius is a constant `BODY_RADIUS * scale` — so at `MIN_ZOOM`
(20) a working planet is about 19px across, against roughly 58px at the
default zoom of 60. Its title does not shrink at all: labels are drei `<Html>`
and draw in CSS pixels at a fixed 11px, a fact `Planet`'s own label-anchor
comment already leans on. The far view is therefore text with dots under it,
which is the opposite of what zooming out is for.

Planet size does not have to track zoom one-for-one.

## The curve — agreed, not yet built

Let the drawn world radius fall as `zoom^-K`, so on-screen size grows as
`zoom^(1-K)`. Today `K = 0`. `K = 1` is the other end — a planet that is the
same number of pixels at every zoom, i.e. a map pin. That end is ruled out for
Orbital: the planet is drawn as an instrument (tick ring, arc ring, core,
border) transcribed from a 50px-radius reference, and zooming in to read that
detail is a real gesture.

The agreed shape is in between, and one-sided:

```
factor = clamp((REFERENCE_ZOOM / zoom) ** K, 1, FACTOR_MAX)
```

- `REFERENCE_ZOOM = 60`, the map's default zoom (`INITIAL_CAMERA`).
- `K` around 0.4–0.5. Start at 0.5 and tune it on screen.
- **Clamped to 1 from below**, which is the point of the one-sided form:
  nothing at or above the default zoom changes at all, so the close-up stays
  exactly as the canvas draws it and only the far view inflates.
- `FACTOR_MAX` around 1.7 — see the headroom arithmetic below.

At `K = 0.5` that puts `MIN_ZOOM` (20) at a factor of 1.73, so a 19px planet
becomes 33px, and the clamp catches the very bottom of the range rather than
the curve running away there.

## How much room there is

More than you would guess, because the layout and the drawing use different
units. `layout.ts` places planets in units where `PLANET_BASE_RADIUS = 1`,
while `visuals.ts` draws the body at `BODY_RADIUS = 0.48` — the map already
carries roughly 2× headroom between what the spiral reserves and what is
painted.

Concretely, for a cluster of scale-1 planets the spiral's spacing constant is
`K = 2*1*1 + MIN_GAP + SPIRAL_SAFETY_MARGIN = 2.5`, and that is also the
closest any two planets ever come (the `i=0, i=1` pair, per `spiralSpacing`'s
note). Two bodies of radius 0.48 touch at a factor of `2.5 / 0.96 ≈ 2.6`. A
cap around 1.7 sits comfortably inside that, and cluster separation — derived
from bounding radii that also assume the fatter layout radius — has more slack
still.

The tighter thing to look at is moons. `sceneModel` puts the first moon at
`scale * 1 + 0.35 = 1.35` world units from a scale-1 planet's centre, against
a 0.48 body — so a body inflated past ~2.8× would swallow its own moons, and
a moon shell inflated along with the body meets the neighbouring planet's
sooner (two 1.35 shells already exceed the 2.5 spacing today, which is
existing behaviour rather than something this would introduce). Whether the
factor applies to `orbitRadius` as well as to the moon's own body is the one
genuine design decision here.

## Where it goes

Camera state lives in `SpaceMap`'s local `useState` and deliberately never
reaches the store or `buildSceneModel` (`useSceneModel` says so outright), so
a `zoomFactor` prop is the wrong shape: it would re-render every planet on
every wheel notch.

`Planet`'s frame loop already ends with
`groupRef.current.scale.setScalar(scale * hide.scale)`. The factor is a third
multiplicand there, read from `state.camera.zoom` inside `useFrame` — no
allocation, no React work, and it composes with the ended-hide fade for free.
`Moon` needs the same, since moons are rendered as siblings of the planets in
`SpaceMap`, not as children of the planet group, and so inherit nothing.

Two consequences to plan for:

- The JSX `scale` prop stays the pre-first-frame value (and the only value in
  jsdom, where `useFrame` never runs), so the frame loop's factor is invisible
  to component tests. Put the curve in a pure exported function beside
  `clampZoom` in `camera.ts` and unit-test that, the way `isNearBottom` and
  `compensatePrepend` are tested rather than the scrolling they drive.
- `fitView` frames positions only and pads by `FIT_PADDING = 2` world units.
  Fit is precisely where the factor is largest, so it is worth checking that
  an inflated edge planet still lands inside the frame the fit computed.

## Two things it also buys

The click target is the mesh, so planets at low zoom become easier to hit, not
just easier to see. And it narrows the gap between a body that scales and a
label that does not, which is the real reason the far view reads badly.

Worth holding against [[map-ended-declutter]] before picking the numbers: the
far view is also where clutter is worst, and bigger planets push the other
way. Ended planets stay relatively small on their own (`ENDED_SCALE = 0.44`,
and often suppressed outright), so the factor multiplying through is probably
enough — but that is the thing to look at on the canvas first.
