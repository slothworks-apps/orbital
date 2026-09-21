#!/bin/sh
# Regenerates desktop/build/icon.icns from the web favicon artwork.
#
# icon.icns is a checked-in source asset (like the PNGs it's built from),
# not a build output, so this script is not part of `desktop:dist` — run it
# by hand after the favicon artwork changes, then commit the new icns.
#
# macOS-only: relies on qlmanage, sips and iconutil, all part of the base
# system. No npm dependency is added for this.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SRC_SVG="$REPO_ROOT/web/public/favicon.svg"
SRC_512="$REPO_ROOT/web/public/favicon-512.png"

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

echo "wrote $HERE/icon.icns"
