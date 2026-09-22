---
id: needs-input-pill-never-fades-in-on-a-settled-planet
title: The NEEDS INPUT pill never fades in on a planet that mounts already parked
status: done
type: fix
domain: map
related:
  - state-change-snaps-the-planet-scale
  - what-a-session-waits-for-is-a-label
tags:
  - web
  - map
  - motion
---
# The NEEDS INPUT pill never fades in on a planet that mounts already parked

## What happens

The detail panel says NEEDS INPUT and the planet shows no pill at all. The
session is one and the same; the two readouts disagree about it.

It is not intermittent once it happens: the pill stays missing for that
planet's whole life on the map. Reproduced by loading the map with a session
already parked — a page reload, a session entering the visible set, or a
freshly created one that starts in `needs_input`.

## What it turned out to be

Nothing to do with the data. Both readouts read the same `session.status` out
of the same store; the map's copy was right all along and simply drew the pill
at `opacity: 0`.

`StatePill` renders with a hardcoded `opacity: 0`, and the only thing that ever
wrote it was `applyState()` in `Planet.tsx`, which the frame loop calls while
the state mix is MOVING plus the one frame after it settles:

```js
const applied = mixMoved || hueMoved || hideMoved || !settled.current
if (applied) applyState()
```

A planet that mounts *already* in `needs_input` has nothing moving —
`useStateMix` seeds itself at the target — so `applied` is true for exactly one
frame, the `!settled.current` one. And on that frame the node it wants to write
does not exist yet: `<Html>` (drei 10.7.8, `web/Html.js`) renders its children
through a React root of its own —

```js
const currentRoot = (root.current = ReactDOM.createRoot(el))
// …
root.current.render(<div ref={ref}>{children}</div>)
```

— created and rendered inside a layout effect, and `createRoot().render()`
commits asynchronously. So `badgeRef.current` is still `null` for the parent's
first frame, the one write is dropped, and nothing ever runs again to make a
second.

A planet that *transitions* into `needs_input` while mounted was fine, which is
why this survived: the mix moves for `STATE_TRANSITION_MS`, the node appears
within a frame or two, and every later frame writes the opacity. The `/compact`
pill beside it was fine for a different reason — it is written every frame it
is mounted, outside `applyState`.

## The fix

The pill gets its own fade, `pillFade`, advanced and written on every frame it
is mounted — the `/compact` pill's shape — so a dropped first write is repaired
by the next frame instead of being permanent. Its mounted opacity is also
seeded from that tween rather than from `0`, the way the planet's label already
seeds itself from `hideFade.value`, so a pill that mounts settled is correct on
its very first painted frame.

Moving the fade off the state mix is also what let the pill carry a label the
mix has no weight for — see [[what-a-session-waits-for-is-a-label]].

## Why there is no test

The failure lives in the ordering between an R3F frame and drei's portal
commit; jsdom runs no frame loop, so a test could only re-assert the code it is
testing. The invariant that replaces it is in the comment on `pillFade`: the
pill's opacity is written per frame while mounted, never from `applyState`.
