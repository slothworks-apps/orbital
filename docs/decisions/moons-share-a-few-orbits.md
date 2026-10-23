---
id: moons-share-a-few-orbits
title: Moons share a few orbits, and a placed moon stays where it is
type: adr
status: in-force
domain: web
related:
  - 2026-10-21-moon-orbit-limit-design
  - orbit-step-clears-the-moon-at-any-planet-size
tags:
  - space-map
---
# Moons share a few orbits, and a placed moon stays where it is

`orbit-step-clears-the-moon-at-any-planet-size` describes each moon riding
its own orbit and advancing its own angle from the moment it mounts. That
is no longer so: a planet's moons share at most `MOON_ORBITS_DEFAULT`
orbits (spec 2026-10-21-moon-orbit-limit-design). The step between orbits
that ADR chose still holds.

**Chosen: a placed moon keeps its slot; a newcomer takes the widest gap.**
`placeMoons` takes the previous scene model's slots, so a moon arriving or
leaving moves no other. Ruled out: spreading the moons on an orbit evenly
again on every change — a tidier ring, but the map would move each time a
subagent starts or ends, against the calm `why-orbital` keeps.

**Moons on one orbit turn together.** The angular speed reads the orbit's
target radius, not the radius tween, and a moon joining an orbit takes its
angle from a moon already on it (`orbitRiders` in `Moon.tsx`). Ruled out:
an angle computed from a shared clock — it would also need the offline
hold, which stops a planet's moons mid-orbit, to be replayed.

**The separation is measured at the smallest planet tier.** A session going
idle shrinks its planet and its orbits; measured at the current size, a
placed moon could stop clearing its neighbour and jump to a new gap. Taken
at the smallest tier, only a change the user makes — the limit or the
planet-size slider — can place a moon again.

**A moon past the limit stays until the limit changes.** When every allowed
orbit is full, one more opens past it. Such a moon records the limit it was
placed under and keeps its slot while that limit holds, rather than moving
inward the moment a gap opens.
