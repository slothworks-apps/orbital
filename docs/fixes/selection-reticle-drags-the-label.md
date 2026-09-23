---
id: selection-reticle-drags-the-label
title: The selection reticle drags the planet's title with it, and pops rather than arrives
status: done
type: fix
domain: web
related:
  - 2026-09-15-orbital-design
tags:
  - space-map
  - motion
---
# The selection reticle drags the planet's title with it, and pops rather than arrives

Selecting and deselecting a planet did not read as one surface fading in and
out. The title shifted, and the dashed ring was simply there and then simply
gone. Five things were behind it.

## The label rode the reticle

`Planet`'s frame loop interpolated the label group's `y` on the reticle's own
fade, so the resting title would slide clear of the bracket square at ±100px.
The travel is only 0.23 world units — about 14px at the default zoom, over
140ms on deselect. What made it conspicuous is that the label was the only
thing in the frame that was **not** fading: its opacity is driven by
`hideFade` (the ended suppression) and never by selection, so while the ring
and brackets dissolved, the text slid at full strength. The eye follows the
one thing that moves.

**Fixed by pinning the label at `LABEL_TOP_REST_Y` and deleting the
interpolation.** The canvas was re-read before doing it and does not object:
artboard 1f's "Selected" cell draws the reticle on a planet with no title
under it at all — the text below it is the state sheet's own caption at a
fixed `top:206px` — and `1.5px solid #fff`, the corner brackets, appears
exactly once in the whole of `Orbital.dc.html`. The design never specifies a
selected planet *with* a label, so the overlap was unaddressed rather than
accepted, and the slide was the implementation's own invention. If the overlap
looks wrong on screen, the reticle should move — fade the bottom bracket while
a label is under it, or shorten it — not the text.

## 2026-09-23: the overlap is resolved by dropping the label

Pinning the label left the bottom brackets running through the title of a
selected planet, and on screen that did look wrong. Tomin asked for the
overlap to go.

**The label now drops below the reticle's bracket square while the planet is
selected.** It works the same way as the drop a gauged planet already had
below the gauge's tick ring. `labelRestY(gauged, selected)` in `visuals.ts`
picks the lowest place: under the brackets (`LABEL_SELECTED_REST_Y`, which is
`BRACKET_INSET` plus the label's usual 34px gap, `LABEL_GAP`), under the tick
ring (`LABEL_GAUGED_REST_Y`), or under the body (`LABEL_TOP_REST_Y`).

The drop does not slide, which is what this document warned against. The
label fades out where it is, jumps while it is invisible, and fades back in
at the new place. All three steps follow the reticle's own fade:
`labelUnderReticle` flips at `SELECTION_LABEL_HANDOFF`, and
`selectionLabelOpacity` reaches zero at exactly that point (`transition.ts`,
tested in `visuals.test.ts`). The text never moves while it can be seen. The
label group's `y` is now written by the frame loop instead of a JSX prop, so
it still has one owner. The hover scrim is a child of the same group and
drops with it.

**The simulation knows about the drop.** `planetOutline` takes `selected` and
measures the label from `labelRestY`, so the box of a selected planet
reaches the dropped label. Its neighbours walk clear of the label instead of
the label landing on them. This changes one point of
[[separation-rests-at-the-outline]]: the reticle still never pushes the
neighbours, but selecting a planet now moves the neighbour below it by the
length of the drop. `simulation.test.ts` has two selected clusters in its
acceptance check. Without the sim change, the three-planet one fails with the
dropped label 9.5px inside a neighbour's body.

**Why the reticle was not shortened instead.** The reticle is the canvas's
element: 1f draws four equal corner brackets, and taking out or fading the
bottom pair would change the design to fit around our label. The label drop
already existed for the gauge, and it is a rule the owner has already
accepted. The simulation also already models label offsets, so reusing the
drop costs one more case. Changing the reticle's shape would have needed a
new canvas decision.

## A re-render could snap it

The label group carried `position` as a JSX prop while the frame loop wrote
`position.y` every frame — the hazard rule 1 in `Planet`'s own header states
for materials. With the interpolation gone the prop is now the only owner, so
this is fixed by construction rather than by a rule anyone has to remember.

`SelectionReticle`'s two `opacity={0}` props were the same smell and got the
same treatment: the frame loop owns those opacities, so they are zeroed in a
layout effect on mount instead of being re-applied by R3F on every render. A
selected `working` session re-renders on every WS update, so that blanked
frame was coming up constantly.

## The ring had no entrance

`RETICLE_ENTER_MS` / `RETICLE_EXIT_MS` were the modal pair from `ui/motion.ts`
(180/140), and opacity was all that moved. On a 1px dashed ring that is under
three frames of change, which is why it read as appearing rather than
arriving.

They are now **320/200**, with a small scale settle: `reticleEnterScale`
carries the whole mark from 1.06 to 1.0 on the way in and back out on the way
out, so it dissolves outward rather than ceasing. The scale is written on a
new outer group that owns nothing else — the spin still owns `rotation.z` on
the group inside it, so neither writes the other's property. `ui/motion.ts`'s
rule still holds: the exit is shorter than the entrance.

The scale is a judgement call and is marked as one in the code. An artboard
cannot specify an entrance, so there was nothing to transcribe.

## The unmount could win the race

`useLingering(selected, RETICLE_EXIT_MS)` held the group for a wall-clock
140ms while the fade needs 140ms of *rendered frames*; a dropped frame let the
timer win and the group left while the ring was still faintly visible — a pop
at the end of the exit. It now holds `RETICLE_EXIT_MS +
RETICLE_LINGER_GRACE_MS` (two frames at 60fps), enough to cover a dropped
frame without leaving five invisible `Line` draw calls standing on a map that
can hold fifty planets.

## The ring turned four times too fast

`RETICLE_SPIN_SPEED` was `2π/40` — one revolution every 40 seconds — and the
comment beside it cited `orb-spin 40s`. The canvas has the reticle at
**`orb-spin 160s`**, and `grep` over `Orbital.dc.html` finds no `orb-spin 40s`
anywhere in it. Mis-transcribed rather than moved. Now `2π/160`.

The geometry around it was faithful and is unchanged: the ring's `inset:-42px`
is the code's `px(92)`, and the brackets sit at ±100px.

## Where the arithmetic went

`reticleEnterScale` lives in `web/src/map/transition.ts`, not in the frame
loop, because `useFrame` never runs under jsdom — arithmetic left in `Planet`
cannot be tested at all. `web/src/test/visuals.test.ts` covers it alongside
`endedHideTransform`: exactly 1 when selected, monotonic across the fade, and
the duration rules (exit shorter than entrance, entrance longer than a modal,
mount outlasting the tween).

Reduced motion stays instant on all of it — `retargetTween` already collapses
the duration, and `useLingering` already short-circuits its timer.
