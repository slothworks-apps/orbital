---
id: search-mutes-planets-instead-of-hiding-them
title: The sidebar search mutes planets on the map instead of hiding them
status: in-force
type: adr
domain: sessions
related:
  - origin-filter-scopes-to-map-and-active
tags:
  - sidebar
  - space-map
---
# The sidebar search mutes planets on the map instead of hiding them

## The problem

The sidebar search box (`ui.search`) used to live in `visibleSessions`, and
the map derived its bodies from that selector through `mapSessions`. So
typing a query removed every non-matching session from the map. Cluster
membership, the spiral layout, the cluster anchors and the spring simulation
all saw a smaller set, reflowed, and every remaining planet jumped to a new
spot. The map changed shape with every keystroke. That is the opposite of
what a search is for: you look for something on a map you already know, and
the map should hold still while you look.

## What we decided

The map ignores the search when it lays out. `mapSessions` applies the tag
filter, the origin filter and the hole's absorption, but not the search, so
layout, clusters, anchors and the simulation get the same bodies whether or
not a query is typed. Nothing moves when you type.

Sessions that do not match are drawn **muted**:

- `buildSceneModel` sets `ScenePlanet.muted` and `SceneMoon.muted` (a muted
  planet's moons mute with it).
- `Planet` and `Moon` fade to `MUTED_OPACITY` and blend their hue toward the
  ended grey. They use their own tween on the state-change curve, so the
  bodies fade rather than snap.

The rule for what matches is one exported predicate in `store.ts`
(`matchesSearch`, since the amendment below wrapped in
`matchesSidebarFilters`). `visibleSessions` uses it too, so the sidebar and
the map can never disagree about what matches.

What each surface counts:

- **The sidebar** is unchanged. Its lists and its `N sessions` footer still
  filter by the search.
- **The map's status readout** (`statusCounts`, and the NEEDS INPUT / DONE
  split in `SpaceMap`) counts matching sessions only. It agrees with the
  sidebar, not with the bodies that are only there to hold their place.
- **Cluster labels (`NAME · count`) and the hole's count** describe the
  layout, which no longer changes with the search. They count muted planets
  too.

What still hides: the **origin filter** removes bodies from the map exactly
as before. Absorption into the hole is unchanged too.

### Amended 2026-09-24: the tag filter mutes too

The tag filter used to hide, on the reasoning that it is a standing choice
about which part of your work the map shows, not a quick look for one
session. In use it behaved like the search: you pick a tag to find
something, and the map reflowing around the survivors cost the same sense of
place. So the tag filter now mutes as well. `mapSessions` no longer applies
it, and one predicate, `matchesSidebarFilters` (tag chip and search
together), drives `visibleSessions`, the planets' `muted` flag and
`statusCounts`. The sidebar still lists only the matches.

A planet's hover-expanded title and a moon's hover and active marks are not
muted. Hovering asks to read the name, and a muted planet's name is still
worth reading when you ask for it.

## Alternatives we rejected

**Hide as before.** This is the behaviour we are replacing. It is correct as
a filter and cheap to build, but it makes the map jump. The jump also costs
the one thing the map gives you over a list: knowing where a session is.

**Keep the layout, but drop the non-matching bodies.** Lay out the full set,
then draw only the matches, leaving holes where the rest used to be. The
planets that stay do not move, but the map loses its context. Clusters look
half-empty, a lone match floats in space with nothing around it to show where
it is, and the moment the query is cleared every body pops back at once.
Muting keeps the context visible and still makes the matches stand out.

## What it costs

- A map with many sessions and a narrow query is mostly grey bodies. That is
  intended: they are there to be ignored, and `MUTED_OPACITY` sits well below
  an ended planet's `DIMMED_OPACITY`, so a muted working planet does not read
  as a live one.
- The readout and the cluster labels now count different sets while a query
  is active. The readout matches the sidebar and the labels match the layout.
  We accepted that, because each count describes the thing it sits next to.
