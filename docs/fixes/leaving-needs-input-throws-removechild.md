---
id: leaving-needs-input-throws-removechild
title: A planet leaving NEEDS INPUT throws removeChild in the map's label root
type: fix
status: backlog
domain: map
related:
  - 2026-10-08-landing-site-design
  - needs-input-pill-never-fades-in-on-a-settled-planet
tags:
  - map
---

# A planet leaving NEEDS INPUT throws removeChild in the map's label root

## What happens

When a session goes from `needs_input` back to `working`, the console shows
`removeChild … The node to be removed is not a child of this node`. It comes
from one of the small React roots the map mounts next to a planet for its
labels, most likely the state pill in `web/src/map/Planet.tsx`. The map keeps
working; the error repeats on every such transition.

## Where it was seen

In the website's map demo (`site/demo/map/`), which renders the app's own
`SpaceMap` unchanged, in both dev and production builds, whether the change
came from the demo's scenario or from an Approve click. Not yet reproduced in
the app itself, which renders the same component the same way, so it very
likely happens there too.

In dev the same roots also log "Attempted to synchronously unmount a root",
which points at a label root being unmounted during React's own render.

Reproduced in the app itself on 2026-10-21, on the first such transition
after a page load: a session stopped on a lost login rests (`idle`) once its
login starts (spec 2026-10-21-log-in-from-orbital-design § 3). With
`Node.prototype.removeChild` wrapped, the failing call was the `<Html>`
wrapper of the planet's state pill — `<span data-state-pill="needs_input"
data-mode="dot">` inside drei's absolutely positioned `<div>` — whose node
had already been detached (`parentNode` null) when React's commit came to
remove it. A second transition on the same page did not throw.
