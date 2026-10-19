---
id: phone-thumbnails-are-webp-made-by-sharp
title: The phone's thumbnails are WebP, made by sharp
status: in-force
type: adr
domain: server
related:
  - 2026-10-16-image-sizes-design
  - phone-gallery-refetches-what-it-already-had
tags:
  - images
  - mobile
  - performance
---
# The phone's thumbnails are WebP, made by sharp

## Context

Every byte of an image the phone shows crosses the relay. The Mac sends
thumbnails for gallery tiles and transcript thumbnails, first made as JPEG
by macOS's `sips`, which added nothing to the app. `sips` reads WebP but
cannot write it.

Measured on four real screenshots brought down to 1024 px (2026-10-19):

| original | JPEG q80 (`sips`) | WebP q80 | HEIC q60 (`sips`) |
|---|---|---|---|
| 1.27 MB | 167 kB | 56 kB | 62 kB |
| 512 kB | 70 kB | 18 kB | 22 kB |
| 512 kB | 83 kB | 31 kB | 36 kB |
| 512 kB | 115 kB | 37 kB | 44 kB |

## Decision

Thumbnails are WebP at quality 80, made by `sharp` (libvips) in the server
process. `sharp` is a dependency of `server/`, kept out of its esbuild bundle
and shipped beside it in the DMG with its native binding and libvips for
darwin-arm64 (`desktop/electron-builder.yml`). It loads on first use; a
server where it does not load sends images whole, as before.

## Alternatives

- **JPEG from `sips`** — no dependency, but two to four times the bytes.
- **HEIC from `sips`** — nearly as small with no dependency, but Android's
  WebView does not draw it, so the phone would have to say which format it
  takes.
- **`cwebp`** — not on a user's Mac; shipping it is a dependency too, run
  as a process per image.

## Consequences

- The DMG grows by about 19 MB unpacked (libvips is most of it).
- Thumbnails made as JPEG are swept and made again as WebP.
- A server on Linux now makes thumbnails too.
