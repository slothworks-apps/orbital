---
id: session-labels-collide-at-far-zoom
title: Session labels should thin out at far zoom instead of piling up
status: backlog
type: idea
domain: map
related:
  - the-zoom-range-is-wide-because-fit-is-the-way-back
  - expand-a-planet-label-on-hover
  - map-ended-declutter
tags:
  - space-map
  - camera
---

# Session labels should thin out at far zoom instead of piling up

A planet's title is drawn at a fixed screen size, so it does not shrink with
the map. The further out the camera goes, the closer the planets sit to each
other on screen while their labels keep their full width — and past a point
the labels overlap into an unreadable stack of text with the map behind it.

This is not new and was visible at the old floor of 20 already (two adjacent
sessions in one cluster overlap their titles there). It became easy to
provoke when the zoom range widened to `[5, 400]`
([[the-zoom-range-is-wide-because-fit-is-the-way-back]]): at the bottom of
the range the labels are most of what you can see, and they are mush.

Deliberately left alone with that change — widening the range did not create
the behaviour, only made it reachable — and the far view is still perfectly
usable for what it is for, which is seeing the *shape* of the field.

## Worth trying

- Fade labels out below some zoom, the way `map-ended-declutter` fades ended
  sessions. The far view is for shape and colour, not for reading names.
- Or drop to the cluster labels only (`ORBITAL · 6`), which are already far
  fewer and already positioned to avoid each other.
- Or hide a label whose box would intersect a neighbour's, keeping the
  selected and working ones — the pass would run in `sceneModel`, which
  already knows every label's anchor.

Note that a label is not part of what `fitView` frames (it frames positions),
so any of these changes what you see at a given zoom without changing where
fit lands.
