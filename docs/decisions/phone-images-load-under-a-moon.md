---
id: phone-images-load-under-a-moon
title: The phone's images load under a slow moon, not a striped box
status: in-force
type: adr
domain: mobile
related:
  - why-orbital
tags:
  - mobile
  - ui
---
# The phone's images load under a slow moon, not a striped box

## The problem

The mobile-next spec ruled out any spinner: a loading image was a reserved
box in diagonal stripes with its size at the centre and a byte bar under it
(canvas 10e LOADING). Used on the phone, the stripes read as a placeholder
standing in for the picture rather than as "on its way", and they showed
even for a load that took a fraction of a second. Transcript thumbnails had
nothing at all — an empty frame.

## What was decided

Canvas 10e2 MOON replaces 10e LOADING in the viewer and the transcript
thumbnails: a small neutral planet with one moon on a dashed orbit. It stays
within the calm in [[why-orbital]]:

- It appears only after `LOADER_DELAY_MS`; a load faster than that shows
  nothing but the image.
- Its motion is slow and linear (one moon turn in eight seconds, one orbit
  turn a minute) and stops when no byte has come for `FILE_STALL_MS`, so a
  stuck load looks stuck instead of busy.
- When the size is known the orbit fills as an arc, as the context ring
  does; the viewer's foot carries the byte count the bar used to.
- The image fades in on top; the moon is removed only once it is opaque.

## What was considered

Keeping the striped box and only delaying it would have left the
placeholder look the change was asked for. A generic spinner was ruled out
by its speed: anything turning in about a second pulls the eye, which
[[why-orbital]] rules out.
