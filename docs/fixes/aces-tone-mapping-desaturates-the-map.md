---
id: aces-tone-mapping-desaturates-the-map
title: The map rendered every colour through ACES tone mapping, so nothing matched the canvas
status: done
type: fix
domain: web
related:
  - 2026-09-15-orbital-design
tags:
  - space-map
  - color
---
# The map rendered every colour through ACES tone mapping, so nothing matched the canvas

Side by side with the canvas, the running app was duller: the core's cyan read
pale instead of vivid, the tick ring greyed out, the body's teal went flat.
Every colour, not one of them — the shape of a pipeline problem rather than a
transcription mistake.

## The cause

`SpaceMap` mounted `<Canvas orthographic camera={…}>` and said nothing about
the renderer. React Three Fiber's default:

```js
gl.toneMapping = flat ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping
```

So the scene was tone-mapped with ACES Filmic, whose whole purpose is to roll
film-like highlights off a wide-gamut HDR render — and whose signature is
exactly this, saturated bright colours desaturating as they approach the top
of the range. The export is plain CSS in a browser, tone-mapped by nothing, so
the two could never agree while it was on.

## The fix

One prop — `<Canvas flat orthographic …>` — with a comment naming this file,
because the next person to read that line will not guess that a missing word
is what greyed out the map.

`linear` is deliberately NOT alongside it: that switches the output colour
space, and the rest of the colour path is already right.

## What was checked and left alone

- `setOklchTagColor` does a real OKLab → linear-sRGB conversion and hands the
  result to `setRGB(..., THREE.LinearSRGBColorSpace)`. Correct: three's
  working space *is* linear-sRGB, so nothing is converted twice.
- `bodyGradient` tags its `CanvasTexture` `THREE.SRGBColorSpace`.
- `glowTexture` does not tag its texture — harmless, because that one is pure
  white with a varying alpha and alpha is never colour-managed. Left as is
  rather than "fixed" into a change with no effect.

`npm run test:run -w web` passes (747 tests). Nothing asserted the renderer's
tone mapping before or after; the change is visual by nature, and jsdom has no
WebGL to assert it in.

## Still open

Hue constants transcribed while ACES was on may have been nudged brighter to
compensate for it, and will now overshoot. Worth re-reading the map's colours
against the canvas.

Separately: the running planet carries a solid grey annulus between the tick
ring and the body where the close-up artboard has only a thin ring line. It
may be a state difference rather than a defect, and it is not explained by
tone mapping — its own look.
