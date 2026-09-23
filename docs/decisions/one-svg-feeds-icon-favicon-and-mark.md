---
id: one-svg-feeds-icon-favicon-and-mark
title: One SVG feeds the app icon and the favicon; the menu mark is a second, tileless file
status: in-force
type: adr
domain: desktop
related:
  - desktop-wrapper-electron
tags:
  - design
  - packaging
  - branding
---

# One SVG feeds the app icon and the favicon; the menu mark is a second, tileless file

## The problem

The canvas `App Icon - A front` replaced the first-pass mark — a flat `#05070d`
tile with a hairline ring — with the shipped artwork: a navy gradient ground
with a top sheen, the orbit centred on the tile, and one body on its near side
occluding the ring. It lists five files, and it is not obvious from the list
which of them are actually distinct artwork and which are the same drawing
exported at different sizes.

Three places consume it, and they do not want the same thing:

- macOS wants a rounded tile at ten sizes inside `icon.icns`.
- The browser tab wants a vector plus three PNG rasters.
- The sidebar header and the collapsed rail want the mark _without_ the tile,
  at 18px, next to the `ORBITAL` wordmark.

## The decision

**`assets/app-icon.svg` and `assets/favicon.svg` on the canvas are byte-identical
artwork, so the repository keeps one copy of it.** `web/public/favicon.svg` is
that file, and `desktop/build/make-icon.sh` already read it as the `.icns`
master, so the icon side needed no rewiring. Two files would have to be kept
in step by hand for no gain.

**The PNG rasters are rendered locally from that SVG, not downloaded from the
design project.** `DesignSync` can only return a file inline, so pulling a
512px PNG through it is impractical. `make-icon.sh` already renders the SVG
with `qlmanage` and downscales with `sips`, so it grew three lines and now
writes `favicon-512/180/32.png` too. One command, one renderer, every size.

**Transparency is recovered from two renders, not from a second renderer.**
`qlmanage` flattens transparency onto white, and until 0.5.0 that shipped: the
icon had opaque white corners around its rounded tile, visible in the DMG
window. The script now renders the SVG once as-is and once over a black rect,
and `desktop/build/unflatten.mjs` takes the alpha from the difference between
the two. That keeps the pipeline on stock macOS tools plus Node's zlib. `sharp`
or `resvg` would render transparency directly, but that would mean a native
npm dependency for a script someone runs by hand a few times a year. The
earlier fallback, which upscaled `favicon-512.png` when `qlmanage` failed, is
gone. It could only ever produce the flattened icon, and it is better for the
script to fail.

**The icon is inset on Apple's grid; the favicon is not.** `.icns` sizes
render from a widened viewBox, so the tile takes `ICON_TILE` of `ICON_CANVAS`
(see `make-icon.sh`) and the rest is transparent margin. Drawn full-bleed, the
tile looked larger than every other app icon in the Dock and Finder. A browser
tab has no such grid, so the favicon rasters stay full-bleed and only lose
their white corners.

**The committed SVG drops the C2PA manifest the canvas asset carries.** The
manifest is ~6 KB of base64 against ~1.5 KB of drawing, and the favicon is
served on every page load. The provenance record stays on the canvas, which is
the source of truth for the artwork anyway.

**The sidebar mark is a second file, and `ui/Logo` inlines it rather than
loading `orbital-mark.svg` over HTTP.** It is genuinely different artwork — no
tile, no `feGaussianBlur`, a 24 viewBox — so it cannot be derived from the icon
by scaling. Inlining it avoids a request for ~600 bytes and lets the gradient
ids be made per-instance with `useId`, which matters because the header and the
collapsed rail are both mounted at once.

**The mark's ambient glow is a CSS `drop-shadow`, not an SVG filter.** The
artboard asks for this explicitly so the same file can become a menu-bar
template image later, where macOS wants flat artwork and applies its own
treatment. An `feGaussianBlur` baked into the file would have to be stripped
at that point.

## What this rules out

- Rendering the sidebar mark from `favicon.svg` scaled down. Below 14px the
  body merges into the ring, which is why the artboard specifies 18px and a
  separate drawing.
- Rebuilding the mark out of CSS boxes, as the previous `ui/Logo` did. The
  shipped mark has two gradients and a halo; a bordered `<span>` cannot carry
  them, and the values would drift from the canvas.

## Consequences

When the artwork changes: replace `web/public/favicon.svg`, run
`desktop/build/make-icon.sh`, and — only if the mark itself changed — update the
inline circles in `web/src/ui/Logo.tsx`. `icon.icns` and the PNGs are
checked-in source assets, not build outputs, so the script's output is
committed rather than produced by `desktop:dist`.

Nothing in `index.html` or `site.webmanifest` changed: the file names are the
same and only the bytes behind them moved.
