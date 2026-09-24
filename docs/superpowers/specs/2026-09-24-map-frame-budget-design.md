---
id: 2026-09-24-map-frame-budget-design
title: "The map draws only when something moves, capped by a user-set frame rate"
type: spec
status: done
domain: map
related:
  - resource-usage-pass-2026-09-24
  - 2026-09-21-settings-sections-design
tags:
  - web
  - map
  - performance
---

# The map draws only when something moves, capped by a user-set frame rate

Finding 1 of [[resource-usage-pass-2026-09-24]]: the map renders at the
display refresh rate forever. That is ~40 % of a core and ~1.2 GB of GPU memory
while the window sits idle behind the IDE.

## 1. Behaviour

- **Nothing moves, nothing draws.** With no running animation, no tween, no
  awake physics body, no drag and no camera motion, the canvas renders zero
  frames.
- **Frame cap while something moves.** Whenever anything is moving, the map
  draws at most *N* frames a second:
  - *N* is `map_fps_focused` while the window has focus;
  - *N* is `map_fps_background` while it does not.

  The cap covers everything the map draws: ambient motion (orbits, spins,
  blinks, breathing), transitions, the camera and physics.
- **Hidden means stopped.** A hidden window (`document.hidden`, e.g. the
  desktop window after the red button) draws nothing, whatever the settings
  say.
- **Input still gets a frame.** Pointer and wheel input, store changes and
  prop changes request a frame, so hover, selection and drag feedback never
  wait for the next ambient tick.
- **Simulation speed is independent of frame rate.** Physics and every
  time-based animation advance by elapsed time. The same motion takes the same
  wall-clock time at 30, 60 or 120 fps. This fixes today's double-speed
  physics on 120 Hz displays, where `round(dt / TICK_SEC)` rounds a half step
  up to a whole one; time now accumulates across frames.

## 2. Settings

The Appearance section gets two rows under `MAP`. Both are sliders in the
same pattern as "Default planet size", including a RESET to the default.

| key | default | range | meaning |
|---|---|---|---|
| `map_fps_focused` | 60 | 15–120, step 15 | cap while the window is focused |
| `map_fps_background` | 30 | 0–60, step 5 | cap while unfocused; 0 = the map pauses |

The keys live in the existing `settings` key/value table and are read through
the store's `settings` like the other `map_*` keys. A missing or unparsable
value falls back to the default. Values are clamped to the range. Changes
apply immediately, with no reload.

A cap above the display's refresh rate has no effect; the browser will not
draw faster than the display.

Visual placement and copy follow the canvas. If the canvas has no artboard for
these rows yet, they ship in the planet-size pattern and get a Claude Design
pass afterwards.

## 3. CSS animations

The sloth easter egg's drift and bob pause (`animation-play-state: paused`)
while the window is unfocused or hidden. Status pulses (`orbital-pulse`) stay:
they run only while something is working, the compositor handles them cheaply,
and they are the signal the user is scanning for. They get the reduced-motion
guard that `orbital-spin` already has.

## 4. Out of scope

- dpr and antialiasing changes: they change how thin lines look, so they need a
  design call first;
- `React.memo` on planets and moons, and batching WS messages (finding 6);
- per-display automatic caps.
