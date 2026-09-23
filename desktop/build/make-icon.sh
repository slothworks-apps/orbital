#!/bin/sh
# Regenerates the whole icon set from web/public/favicon.svg: the three
# favicon PNGs beside it and desktop/build/icon.icns.
#
# The canvas ships the app icon and the favicon as byte-identical artwork
# (adr one-svg-feeds-icon-favicon-and-mark), so that one SVG is the master
# for every size written here. The sidebar mark is NOT — it is separate
# artwork, inlined in web/src/ui/Logo.tsx, and this script does not touch it.
#
# What it writes are checked-in source assets, not build outputs, so this is
# not part of `desktop:dist` — run it by hand after the artwork changes, then
# commit what it wrote.
#
# macOS-only: relies on qlmanage, sips and iconutil, all part of the base
# system. No npm dependency is added for this.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SRC_SVG="$REPO_ROOT/web/public/favicon.svg"
PUBLIC="$REPO_ROOT/web/public"

# The tile's share of the macOS icon canvas, from Apple's icon grid: the
# rounded tile is drawn smaller than the canvas and the rest is transparent
# margin. Full-bleed, the tile reads larger than every other app's icon in the
# Dock, Finder and the DMG window.
ICON_CANVAS=1024
ICON_TILE=824

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"

# render <viewBox> <out.png>: SRC_SVG at ICON_CANVAS pixels, transparency intact.
#
# qlmanage — Quick Look's renderer, the only SVG renderer on a stock macOS —
# flattens transparency onto white, which is what gave the icon white corners
# around its rounded tile. So the drawing is rendered twice, once as-is and
# once over a black rect covering the whole viewBox, and unflatten.mjs
# recovers the alpha from the difference.
render() {
  VIEWBOX="$1"
  MIN="${VIEWBOX%% *}"
  SIZE="${VIEWBOX##* }"
  sed -E "s#(<svg[^>]*)viewBox=\"[^\"]*\"#\1viewBox=\"$VIEWBOX\"#" "$SRC_SVG" > "$WORK/on-white.svg"
  sed -E "s#(<svg[^>]*>)#\1<rect x=\"$MIN\" y=\"$MIN\" width=\"$SIZE\" height=\"$SIZE\" fill=\"\#000\"/>#" \
    "$WORK/on-white.svg" > "$WORK/on-black.svg"
  qlmanage -t -s "$ICON_CANVAS" -o "$WORK" "$WORK/on-white.svg" "$WORK/on-black.svg" >/dev/null
  node "$HERE/unflatten.mjs" "$WORK/on-white.svg.png" "$WORK/on-black.svg.png" "$2" >/dev/null
}

# The favicon keeps the tile full-bleed: a browser tab has no grid to sit in.
FAVICON_MASTER="$WORK/favicon-master.png"
render "0 0 512 512" "$FAVICON_MASTER"
sips -z 512 512 "$FAVICON_MASTER" --out "$PUBLIC/favicon-512.png" >/dev/null
sips -z 180 180 "$FAVICON_MASTER" --out "$PUBLIC/favicon-180.png" >/dev/null
sips -z 32 32   "$FAVICON_MASTER" --out "$PUBLIC/favicon-32.png"  >/dev/null

# The icon widens the viewBox around the 512 artwork so the tile lands at
# ICON_TILE of ICON_CANVAS, centred.
ICON_VIEWBOX="$(awk -v c="$ICON_CANVAS" -v t="$ICON_TILE" 'BEGIN {
  s = 512 * c / t; printf "%.3f %.3f %.3f %.3f", (512 - s) / 2, (512 - s) / 2, s, s }')"
ICON_MASTER="$WORK/icon-master.png"
render "$ICON_VIEWBOX" "$ICON_MASTER"
for SIZE in 16 32 128 256 512; do
  sips -z "$SIZE" "$SIZE" "$ICON_MASTER" --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
  sips -z $((SIZE * 2)) $((SIZE * 2)) "$ICON_MASTER" --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o "$HERE/icon.icns"

echo "wrote $PUBLIC/favicon-512.png, favicon-180.png, favicon-32.png"
echo "wrote $HERE/icon.icns"

# The menu bar's template image (spec 2026-09-22-desktop-background-mode-design).
# Its own glyph, tray.svg, rather than a silhouette extracted from the favicon:
# the app icon is a rounded tile whose shape carries none of the mark, and at
# 16px the ring needs a heavier stroke than the tile's to survive.
#
# qlmanage flattens transparency onto white, so what comes out here is a
# black-on-white render; mask-to-template.mjs turns that into the pure black +
# alpha macOS restyles for light and dark menu bars. Both scales are written,
# because nativeImage looks up the @2x file beside the 1x one.
qlmanage -t -s 512 -o "$WORK" "$HERE/tray.svg" >/dev/null
TRAY_512="$WORK/tray.svg.png"
sips -z 32 32 "$TRAY_512" --out "$WORK/tray-32.png" >/dev/null
sips -z 16 16 "$TRAY_512" --out "$WORK/tray-16.png" >/dev/null
node "$HERE/mask-to-template.mjs" "$WORK/tray-16.png" "$HERE/trayTemplate.png"
node "$HERE/mask-to-template.mjs" "$WORK/tray-32.png" "$HERE/trayTemplate@2x.png"
