---
id: 2026-10-21-moon-orbit-limit-design
title: Moon orbits — a few shared orbits instead of one per subagent
status: done
type: spec
domain: map
related:
  - orbit-step-clears-the-moon-at-any-planet-size
  - moons-share-a-few-orbits
  - why-orbital
tags:
  - map
  - experimental
---
# Moon orbits

## Why

Every running subagent drew its own orbit, so a session with six subagents
wore six rings and grew a footprint that pushed its neighbours away. The
rings say nothing the moons do not already say.

## How it works

- A planet has at most `MOON_ORBITS_DEFAULT` orbits. Its moons share them.
- A new moon goes to the orbit with the fewest moons (the inner one on a
  tie), into the middle of the widest gap between the moons already there.
  The first moon on an empty orbit starts at the orbit's index times the
  golden angle, as moons did before.
- Two moons on one orbit always keep a whole moon plus clearance between
  them (the same distance as the step between orbits), measured at the
  smallest planet tier, so a session going idle never puts them too close. An orbit too full
  for another moon is skipped; when every allowed orbit is full, one more
  orbit opens beyond the limit rather than letting two moons touch.
- Nothing already on the map moves when a moon arrives or leaves: a moon
  keeps its orbit and its place, and the gap a finished moon leaves stays
  open until a new one takes it. A moon is placed again only when its place
  stops being valid — the limit changed under it, or the planet-size slider
  put it too close to its neighbour. A moon past the limit keeps its place
  while the limit stays.
- All moons on one orbit turn at the same angular speed, read from the
  orbit's target radius, so the gaps between them hold. A moon that mounts
  takes its angle from a moon already on its orbit, not from its own mount
  time.
- The dashed trail is drawn once per orbit, not once per moon.

## Scope

- **For whom:** anyone who runs sessions with several subagents.
- **Where it lives:** on by default — the limit is the new behaviour. The
  number itself is a slider in Settings → Experimental ("Moon orbits",
  1–8), while it is tuned.
- **What someone notices after updating:** a planet with four or more
  running subagents draws three rings, with several moons per ring, and
  takes less room on the map.
- **What can be set:** the most orbits a planet draws — but only behind the
  Experimental unlock; without it everyone gets three. Once the number is
  settled, the maintainer decides whether it stays fixed (the slider goes)
  or moves to Appearance beside the frame-rate sliders.
- **Website:** the map demo renders `SpaceMap`, so its planets show the
  shared orbits too.

## Phone

Left out on purpose: the phone has no map. It lists a session's subagents
(`MoonsSheet`, `MoonsChip`), which this does not touch.
