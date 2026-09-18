---
id: state-change-snaps-the-planet-scale
title: A state change snaps the planet's scale while everything else crossfades
type: fix
status: done
domain: space-map
related:
  - planet-animation-sandbox
---

# A state change snaps the planet's scale while everything else crossfades

Reported as "transitions look much smoother and more legible on `/sandbox`
than in the app — maybe a framerate issue, maybe slow the animation down."
It is neither. The sandbox and the app run the same `Planet` code; the
difference is what else the app changes at the same moment.

## Root cause

The state crossfade (`transition.ts`, 420 ms) animates every material the
state touches — but the planet's **size** is not one of them. `layout.ts`
ties scale to status (`ACTIVE_SCALE` 1.0, `IDLE_SCALE` 0.71, `ENDED_SCALE`
0.44), `SpaceMap` passes it as a plain prop, and `Planet`'s frame loop
writes the prop straight onto the group every frame
(`groupRef.current.scale.setScalar(scale * …)`, `Planet.tsx`). There is no
scale tween — `usePointTween` exists for position, nothing exists for scale.

So in the app, working → idle is a **one-frame 29 % size snap** (idle →
working, +41 %) with a 420 ms crossfade happening on the already-snapped
body. The snap is the dominant visual event; the crossfade the sandbox
shows so cleanly is still there, just masked. The sandbox never changes the
`scale` prop, which is why the same transition reads as smooth there.

Two smaller contributors, also absent from the sandbox:

- **The whole cluster can move at the same time.** `spiralSpacing` depends
  on the cluster's max scale, so one session's tier change re-spaces the
  spiral and every neighbour walks for 700 ms (`BODY_MOVE_MS`).
- **On-screen size.** At the map's default zoom 60 a working body is ~58 px
  (idle ~41 px) against the sandbox's design-scale 100 px, so the tick-ring
  dissolve has half the pixels to be legible in.

Framerate is not a plausible cause with 4–5 sessions, and all transitions
are wall-clock (`delta`-based), so a lower fps would change smoothness, not
speed.

## Fix (implemented)

`useScaleTween` in `transition.ts` eases the tier scale on the same 420 ms
/ `cubic-bezier(.2,.8,.2,1)` curve as the state mix; `Planet` renders the
tween's current value and multiplies it into the frame-loop scale write,
next to `hide.scale`. Slowing `STATE_TRANSITION_MS` down was not the fix —
the jerk would have survived at any duration while the snap stayed
unanimated.

The Appearance `planet_scale` slider is deliberately OUTSIDE the tween:
`SpaceMap` now passes the tier (`scale`) and the slider
(`scaleMultiplier`) as separate props, so a slider drag still tracks the
pointer 1:1 instead of easing 420 ms behind it.

The `/sandbox` workbench gained a "scale follows state (layout tiers)"
toggle (on by default) that maps the chosen state through `scaleFor`, so
the full transition — size included — can be replayed on a clean stage.

Not covered: a moon's `orbitRadius` comes from the raw tier scale in
`sceneModel`, so moon orbits still snap on a tier change. Rarely visible —
subagents end when their session stops working — but it is the same class
of bug if it ever shows.
