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
SRC_512="$PUBLIC/favicon-512.png"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"

# 512@2x (1024) is rendered straight from the SVG via Quick Look's renderer,
# which produces a clean, crisp 1024x1024 PNG on this pipeline. If qlmanage
# is unavailable or produces a broken render on some other machine, fall
# back to upscaling favicon-512.png with sips instead — the art goes soft
# at 1024 but stays correct, which is an acceptable degradation noted here
# rather than silently shipping a blank icon.
qlmanage -t -s 1024 -o "$WORK" "$SRC_SVG" >/dev/null
SRC_1024="$WORK/favicon.svg.png"
if [ ! -s "$SRC_1024" ]; then
  echo "make-icon.sh: qlmanage produced no 1024 render, upscaling favicon-512.png instead (softer at 1024)" >&2
  sips -z 1024 1024 "$SRC_512" --out "$SRC_1024" >/dev/null
fi

# The favicon rasters index.html and site.webmanifest point at. Written here,
# after the fallback above has had its chance to read the OLD favicon-512.png,
# and before the iconset below downscales from the new one.
sips -z 512 512 "$SRC_1024" --out "$PUBLIC/favicon-512.png" >/dev/null
sips -z 180 180 "$SRC_1024" --out "$PUBLIC/favicon-180.png" >/dev/null
sips -z 32 32   "$SRC_1024" --out "$PUBLIC/favicon-32.png"  >/dev/null

# All sizes <=512 downscale from the pre-rendered favicon-512.png.
sips -z 16 16     "$SRC_512" --out "$ICONSET/icon_16x16.png"      >/dev/null
sips -z 32 32     "$SRC_512" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z 32 32     "$SRC_512" --out "$ICONSET/icon_32x32.png"      >/dev/null
sips -z 64 64     "$SRC_512" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 128 128   "$SRC_512" --out "$ICONSET/icon_128x128.png"    >/dev/null
sips -z 256 256   "$SRC_512" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$SRC_512" --out "$ICONSET/icon_256x256.png"    >/dev/null
sips -z 512 512   "$SRC_512" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
cp "$SRC_512" "$ICONSET/icon_512x512.png"
sips -z 1024 1024 "$SRC_1024" --out "$ICONSET/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$ICONSET" -o "$HERE/icon.icns"

echo "wrote $PUBLIC/favicon-512.png, favicon-180.png, favicon-32.png"
echo "wrote $HERE/icon.icns"
