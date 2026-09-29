---
id: orbit-step-clears-the-moon-at-any-planet-size
title: The step between moon orbits clears a whole moon, at any planet size
type: adr
status: in-force
domain: web
related:
  - 2026-09-18-planet-size-design
  - moons-widen-the-body-the-sim-separates
  - counter-zoom-inflates-the-whole-moon-system
tags:
  - space-map
---
# The step between moon orbits clears a whole moon, at any planet size

Moons around one planet drifted into each other. Each moon rides its own
orbit, `MOON_ORBIT_STEP` further out than the last. Each moon advances its
own angle from the moment it mounts, at `ORBIT_ANGULAR_SPEED / radius`. The
golden-angle starting phase only spreads the moons at birth: an inner moon
runs faster and laps its outer neighbour, and a moon that mounts later
knows nothing of where the others have got to. Whenever two moons on
neighbouring orbits lined up in angle, they overlapped. The step was 0.28
and a working moon with its tick ring is 0.44 across. Moons two orbits
apart never touched, so only neighbours were at risk.

**Chosen: the step is a whole moon across plus a clearance.**
`MOON_ORBIT_STEP` is now derived as `2 * MOON_EXTENT_RADIUS +
MOON_ORBIT_CLEARANCE`, where `MOON_EXTENT_RADIUS` is the working tick
ring's outer edge. That is the widest any moon state draws; the transient
needs-input ripple and materializing ring fade as they grow and are
ignored. Moons still pass each other, but with nothing overlapping.

**And the step widens with the Appearance planet size.** The slider draws
the moon's body larger, so a step sized for 1× lets moons touch again at
1.6×. `moonOrbitRadius` takes `planetScale` and multiplies the step by it.
This relaxes the planet-size spec's "orbit radii are untouched": the
innermost orbit still ignores the slider, but the spacing between orbits
follows it. The footprint the simulation separates planets by also takes
the drawn body size, so neighbours make room for it.

## Ruled out

- **One shared rotation for all a planet's moons.** Driving every moon from
  one clock at one angular speed keeps neighbours a golden angle apart
  forever, and the orbits could stay tight. But the system turns like a
  single wheel, and a moon leaving re-indexes the rest into new phases that
  would need their own transition.
- **Moons that yield to each other.** The trailing moon slows while it
  catches its neighbour. It looks the most alive, but moons are independent
  components today and would have to share per-planet state.
- **A step sized for the largest planet size only.** It never overlaps, but
  every map pays the 1.6× spacing even at 1×.

## Cost

A planet with several moons takes noticeably more room: the step is about
twice what it was. The simulation already separates by footprint
([[moons-widen-the-body-the-sim-separates]]), so neighbours walk out
rather than overlap.
