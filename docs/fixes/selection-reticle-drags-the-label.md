---
id: selection-reticle-drags-the-label
title: The selection reticle drags the planet's title with it, and pops rather than arrives
status: backlog
type: fix
domain: web
related:
  - 2026-09-15-orbital-design
tags:
  - space-map
  - motion
---
# The selection reticle drags the planet's title with it, and pops rather than arrives

Selecting and deselecting a planet does not read as one surface fading in and
out. The title shifts, and the dashed ring is simply there and then simply
gone. Three things are behind it, and only the first is a real mistake.

## The label rides the reticle

`Planet`'s frame loop interpolates the label group's `y` on the reticle's own
fade:

```ts
labelGroupRef.current.position.y =
  LABEL_TOP_REST_Y + (LABEL_TOP_SELECTED_Y - LABEL_TOP_REST_Y) * reticleFade.value
```

That is deliberate — the comment above `LABEL_TOP_REST_Y` explains it: the
resting label sits 34px under the body and therefore runs straight through the
bottom edge of the bracket square at ±100px, so while the reticle is up the
label slides clear of it.

The travel is `px(100) + px(8) - (BODY_RADIUS + px(34))` = 0.23 world units,
about 14px at the default zoom, and it happens in 140ms on deselect. What
makes it conspicuous is that the label is the only thing in the frame that is
**not** fading: its opacity is driven by `hideFade` (the ended suppression)
and never by selection, so while the ring and brackets dissolve, the text
slides at full strength. The eye follows the one thing that moves.

## A re-render can snap it

The label group carries `position={[0, LABEL_TOP_REST_Y, 0]}` as a JSX prop
while the frame loop writes `position.y` every frame. This is exactly the
hazard rule 1 in `Planet`'s own header states for materials — R3F re-applies
the prop on the next render and stamps over the frame loop's value. Here the
loop restores it on the following frame (the write is guarded by
`reticleFade.value > 0`, which holds while selected), so the cost is a
single-frame jump of the text rather than a stuck label. But a selected
`working` session re-renders on every WS update, so that frame comes up
often.

## The ring has no entrance

`RETICLE_ENTER_MS` / `RETICLE_EXIT_MS` are 180/140ms — the modal durations
from `ui/motion.ts` — and opacity is all that moves. On a 1px dashed ring with
no other motion cue that is under three frames of change, which is why it
reads as appearing rather than arriving. The same in reverse on deselect.

Worth noting what is *not* the cause: `reticleMounted` unmounting the group
after the exit is not what moves the text, and keeping the reticle mounted
permanently would leave five invisible `Line` draw calls per planet standing
on a map that can hold fifty.

There is, though, a race in that unmount. `useLingering(selected,
RETICLE_EXIT_MS)` holds the group for a wall-clock 140ms while the fade needs
140ms of *rendered frames*; a dropped frame lets the timer win and the group
leave while the ring is still faintly visible — a pop at the end of the exit.

And the ring turns four times too fast. `RETICLE_SPIN_SPEED` is `2π/40`, one
revolution every 40 seconds, and the comment beside it cites `orb-spin 40s`.
The canvas has the reticle at **`orb-spin 160s`**, and no `orb-spin 40s`
exists anywhere in `Orbital.dc.html` today — either it was transcribed wrong
or the canvas moved afterwards. The geometry around it is faithful (the ring's
`inset:-42px` is the code's `px(92)`, the brackets sit at ±100px), so this is
the one number to re-take. A reticle circling four times faster than designed
is part of why the selection reads as busy.

## What it should do

- **The title should not move.** Pin the label group at `LABEL_TOP_REST_Y` and
  drop the interpolation. The canvas was checked before writing this down and
  does not object: 1f's "Selected" cell draws the reticle on a planet with no
  title under it at all (the text below it is the state sheet's own caption at
  a fixed `top:206px`), and `1.5px solid #fff` — the corner brackets — appears
  nowhere else in `Orbital.dc.html`. So the design never specifies a selected
  planet *with* a label, the overlap is unaddressed rather than accepted, and
  the slide is the implementation's own invention. Pinning the label is not a
  deviation. If the overlap then looks wrong on screen, move the reticle —
  fade the bottom bracket while a label is under it, or shorten it — rather
  than moving the text.
- **Whatever owns that `y` should own it alone.** If the label has to keep
  moving, stop passing `position` as a JSX prop on a group the frame loop
  writes to, the same way no state-dependent material takes `opacity` as a
  prop today. `SelectionReticle`'s two `opacity={0}` props are the same smell
  and deserve the same treatment.
- **Give the ring an arrival.** Opacity plus a small scale settle (something
  like 1.06 → 1.0), over longer than 180ms, and the reverse on the way out —
  still shorter on exit than on entrance, per `ui/motion.ts`'s rule. The dash
  phase drifting as it arrives would suit a reticle too, and the ring already
  spins.
- **Hold longer than the fade.** `useLingering` should outlast
  `RETICLE_EXIT_MS` by a frame or two, or the unmount should follow the tween
  reaching 0 rather than a timer.

Reduced motion stays instant on all of it — `retargetTween` already collapses
the duration, and that is the right behaviour, not a case to animate around.

## Where

`web/src/map/Planet.tsx`: `LABEL_TOP_REST_Y` / `LABEL_TOP_SELECTED_Y`, the
reticle block at the end of `useFrame`, and `SelectionReticle`. Durations live
in `web/src/map/transition.ts`. None of it is reachable from jsdom, where
`useFrame` never runs — if any arithmetic survives the change, it belongs in a
pure function there and gets tested directly, like `endedHideTransform`.
