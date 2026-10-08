---
id: splash-mark-ships-as-png-on-a-288-canvas
title: The launch screen's mark ships as PNGs on the 288 dp canvas, on Android and iOS alike
status: in-force
type: adr
domain: remote
related:
  - build-the-android-app
  - one-svg-feeds-icon-favicon-and-mark
tags:
  - mobile
  - design
  - branding
---

# The launch screen's mark ships as PNGs on the 288 dp canvas, on Android and iOS alike

## The problem

The Claude Design canvas "Feature - Splash screen" (variant 1a, the mark
alone) asks for a 288 dp VectorDrawable for Android's splash icon and an iOS
image set cut to the mark's 144 pt box. Neither works as written:

- The mark's glow is an SVG `feGaussianBlur`. A VectorDrawable has no blur,
  so a vector would drop the glow or fake it with gradients that do not
  match the canvas.
- The glow and the planet's flare reach past the 144 pt box (the canvas
  itself says the glow reaches 92 dp from the centre). An image cut to that
  box shows a hard edge where the glow is clipped, at the top and the right.

## The decision

**One raster, rendered from the canvas's `splash-mark.svg` onto the 288 dp
canvas, serves both platforms.** `mobile/scripts/make-icons.mjs` widens the
SVG's viewBox so the mark stays 144 dp/pt and centred, renders it with
`qlmanage` (which draws the blur), and writes `drawable-*dpi/splash_mark.png`
and the iOS `Splash.imageset` at 288 pt. The mark's size and position are
what the canvas specifies; only the transparent margin around it grew.

The script fails if anything the mark draws would reach Android 12's Ø192 dp
splash-icon mask, so a redrawn mark cannot be clipped silently.

## Rejected

- **A VectorDrawable with the glow approximated by radial gradients**: a
  ring's blur is an annulus no single gradient draws, and the result would
  drift from the canvas the first time the mark changes.
- **The 144 pt box on iOS as specified**: the visible clip edge.
- **The core-splashscreen defaults without a layer list of our own on
  Android 11 and older**: they draw the same, but the window background is
  then implicit; `drawable/splash.xml` names it, as the canvas asks.
