---
id: 2026-10-16-image-sizes-design
title: Images go up brought down to what the API takes, and come to the phone as thumbnails
type: spec
status: done
domain: sessions
related:
  - 2026-10-01-file-attachments-design
  - 2026-09-18-transcript-images-design
tags:
  - attachments
  - images
  - mobile
---

# Image sizes

## Problem

An image over 5 MB (a Retina screenshot, a camera photo) never reached a
session as an image: on the Mac it went by path, from the phone it was
refused. An iPhone's HEIC, which the API does not take, could not go at
all. In the other direction the phone fetched every stored image whole
through the relay, a thumbnail as much as the lightbox, so a transcript
full of screenshots loaded slowly or not at all on a poor connection.

## 1. Going up: brought down to the API's ceiling

- Any image the API takes (PNG, JPEG, GIF, WebP) or a browser can decode
  (HEIC, HEIF, AVIF, BMP, TIFF) rides as an image block, whatever its
  size (`isInlineImage`).
- Before the upload, `fitImage` (`web/src/lib/imageFit.ts`) sends it as
  picked when it is one of the four types and at most
  `ATTACHMENT_MAX_BYTES` (5 MB). Otherwise it is drawn on a canvas and
  encoded as WebP (it keeps a screenshot's transparency), or JPEG where the
  browser cannot write WebP, at quality 0.9. The longest edge starts at
  most 8000 px (the API's limit), and each next try is scaled by the square
  root of how far over the ceiling the last one came, until it fits.
- Desktop, browser and phone alike: the composer's one upload path does
  it. The phone's own photo step still brings a camera shot down to 1568 px
  first.
- An image the browser cannot decode fails like a refused upload, and the
  chip offers its retry. The server's ceiling is unchanged.

## 2. Coming down: thumbnails for the phone

- `blob_get` takes an optional `edge`. The Mac answers with a JPEG whose
  longest side is at most `edge` (`server/src/images/thumbs.ts`, made with
  macOS's `sips`, quality 80). It answers with the image itself when it
  offers no thumbnail at that edge (512 and 1024 only), when `sips` is
  missing (a server on Linux), or when the thumbnail would be no smaller.
- Thumbnails are made once per ref and edge, in `<imagesDir>-thumbs/<edge>/`.
  They sit beside the store, not in it, because the store prunes every file
  of its own directory. Every 50 thumbnails made, those whose image the
  store has pruned are dropped.
- The phone asks at `PHONE_THUMB_EDGE` (1024) wherever an image is drawn
  small: a transcript thumbnail (`ImageThumb`) and a gallery tile
  (`MediaPicture`). The lightbox and the viewer still ask for the image
  itself. A thumbnail is cached on the phone under its own key, and an
  image already held whole serves its thumbnail too.
- The web and the desktop ignore `thumb`: their images come from the same
  machine.

## Phone

Built for the phone too: § 1 runs in its composer and § 2 is for it. An
older Mac drops the unknown `edge` and sends the whole image, as before,
so no `MAC_FEATURES` row is needed.

## Testing

- The scale arithmetic of § 1 (`imagefit.test.ts`). The canvas encode is
  the browser's and is not run in jsdom.
- `isInlineImage` for images over the ceiling and for HEIC.
- Thumbnails: made smaller and once, refused at an edge not offered and
  for a ref that is not one, the image sent when the thumbnail would be no
  smaller, the sweep. The `sips` cases are skipped where there is no `sips`.
- The phone's resolver: a thumbnail asked with its edge and cached under its
  own key, and served from the image when the image is already held.
