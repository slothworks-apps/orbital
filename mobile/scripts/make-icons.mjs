#!/usr/bin/env node
/**
 * Regenerates the phone app's icons from the artwork the desktop already
 * ships (adr one-svg-feeds-icon-favicon-and-mark):
 *
 * - web/public/favicon.svg, the app icon, becomes the Android launcher icon
 *   (legacy and round PNGs per density, and the adaptive icon's foreground
 *   PNGs and gradient background) and the iOS App Store icon.
 * - desktop/build/tray.svg, the tileless silhouette, becomes the adaptive
 *   icon's monochrome layer (Android 13 themed icons) and the notification
 *   small icon, both as vector drawables.
 * - mobile/scripts/splash-mark.svg, the launch screen's mark (Claude Design,
 *   "Feature - Splash screen", 1a), becomes the Android splash icon PNGs and
 *   the iOS launch image set.
 *
 * What it writes are checked-in source assets, not build outputs: run it by
 * hand after the artwork changes and commit what it wrote.
 *
 * macOS-only, like desktop/build/make-icon.sh and for the same reason: it
 * renders with qlmanage and resizes with sips, and recovers transparency with
 * desktop/build/unflatten.mjs. No npm dependency is added for this.
 *
 * Usage: node mobile/scripts/make-icons.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const FAVICON = join(REPO, 'web/public/favicon.svg');
const TRAY = join(REPO, 'desktop/build/tray.svg');
const UNFLATTEN = join(REPO, 'desktop/build/unflatten.mjs');
const RES = join(REPO, 'mobile/android/app/src/main/res');
const IOS_ICON = join(REPO, 'mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
const SPLASH = join(HERE, 'splash-mark.svg');
const IOS_SPLASH = join(REPO, 'mobile/ios/App/App/Assets.xcassets/Splash.imageset');

/** The favicon's own coordinate space: its tile is ARTWORK units square. */
const ARTWORK = 512;
const CENTRE = ARTWORK / 2;

/** Android density buckets and their scale over mdpi. */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/** Legacy launcher icon: LEGACY_DP square, the tile drawn LEGACY_TILE_DP wide, centred. */
const LEGACY_DP = 48;
const LEGACY_TILE_DP = 44;

/**
 * Adaptive icon: the launcher masks an ADAPTIVE_DP canvas to roughly its
 * middle ADAPTIVE_VISIBLE_DP, and guarantees only the middle
 * ADAPTIVE_SAFE_DP circle. The favicon's tile is mapped onto the visible
 * square, so the composition matches the desktop icon and the ring and planet
 * (which reach 192 units from the centre) stay inside the safe circle.
 */
const ADAPTIVE_DP = 108;
const ADAPTIVE_VISIBLE_DP = 72;
const ADAPTIVE_SAFE_DP = 66;

/** The rendered master's edge, downscaled to every size. */
const MASTER_PX = 1024;

/** The iOS App Store icon: one opaque square; iOS applies its own mask. */
const IOS_PX = 1024;

/** The notification small icon's size; the silhouette fills tray.svg's viewBox. */
const STAT_DP = 24;

/**
 * Launch screen: splash-mark.svg's viewBox is the mark's box, drawn
 * SPLASH_MARK_DP square and centred on a SPLASH_CANVAS_DP canvas, the size
 * Android 12 gives a splash icon without an icon background; Android masks
 * that canvas to a SPLASH_MASK_DP circle. iOS gets the same canvas in points:
 * the glow reaches past the mark's box and would be cut off at its edge.
 */
const SPLASH_MARK_DP = 144;
const SPLASH_CANVAS_DP = 288;
const SPLASH_MASK_DP = 192;

/** The iOS launch image's scales. */
const IOS_SCALES = [1, 2, 3];

const WHITE = '#FFFFFF';

const work = mkdtempSync(join(tmpdir(), 'orbital-icons-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

const favicon = readFileSync(FAVICON, 'utf8');
const tray = readFileSync(TRAY, 'utf8');

// ---- SVG variants of the favicon ------------------------------------------

function withViewBox(svg, min, size) {
  return svg.replace(/(<svg[^>]*)viewBox="[^"]*"/, `$1viewBox="${min} ${min} ${size} ${size}"`);
}

/** The tile's corners: a radius of CENTRE turns the rounded square into a circle, 0 into a square. */
function withCornerRadius(svg, radius) {
  const tileRadius = Math.max(...[...svg.matchAll(/\brx="([\d.]+)"/g)].map((m) => Number(m[1])));
  return svg.replace(/<rect([^>]*?)rx="([\d.]+)"/g, (_, attrs, rx) => {
    // The hairline border sits inset from the tile and keeps its inset.
    const inset = tileRadius - Number(rx);
    return `<rect${attrs}rx="${Math.max(0, radius - inset)}"`;
  });
}

/** The artwork without its tile: background, sheen and border rects dropped. */
function withoutTile(svg) {
  return svg.replace(/<rect[^>]*><\/rect>\s*/g, '');
}

/** Drops the hairline border (the last rect, the only one with a stroke). */
function withoutBorder(svg) {
  return svg.replace(/<rect[^>]*stroke=[^>]*><\/rect>\s*/g, '');
}

function overBlack(svg, min, size) {
  return svg.replace(/(<svg[^>]*>)/, `$1<rect x="${min}" y="${min}" width="${size}" height="${size}" fill="#000"/>`);
}

/** Viewbox that puts the ARTWORK tile at `tile` of `canvas`, centred. */
function insetViewBox(canvas, tile) {
  const size = (ARTWORK * canvas) / tile;
  return { min: (ARTWORK - size) / 2, size };
}

// ---- rendering ------------------------------------------------------------

function qlmanage(px, files) {
  execFileSync('qlmanage', ['-t', '-s', String(px), '-o', work, ...files], { stdio: 'ignore' });
}

/** Renders `svg` at MASTER_PX with its transparency, as make-icon.sh does. */
function renderTransparent(name, svg, { min, size }, px = MASTER_PX) {
  const white = join(work, `${name}-white.svg`);
  const black = join(work, `${name}-black.svg`);
  const framed = withViewBox(svg, min, size);
  writeFileSync(white, framed);
  writeFileSync(black, overBlack(framed, min, size));
  qlmanage(px, [white, black]);
  const out = join(work, `${name}.png`);
  execFileSync('node', [UNFLATTEN, `${white}.png`, `${black}.png`, out], { stdio: 'ignore' });
  return out;
}

function resize(master, px, out) {
  execFileSync('sips', ['-z', String(px), String(px), master, '--out', out], { stdio: 'ignore' });
}

// ---- launcher PNGs --------------------------------------------------------

const legacyBox = insetViewBox(LEGACY_DP, LEGACY_TILE_DP);
const legacy = renderTransparent('legacy', favicon, legacyBox);
const legacyRound = renderTransparent('legacy-round', withCornerRadius(favicon, CENTRE), legacyBox);

const adaptiveBox = insetViewBox(ADAPTIVE_DP, ADAPTIVE_VISIBLE_DP);
const foreground = renderTransparent('foreground', withoutTile(favicon), adaptiveBox);

for (const [bucket, scale] of Object.entries(DENSITIES)) {
  const dir = join(RES, `mipmap-${bucket}`);
  resize(legacy, Math.round(LEGACY_DP * scale), join(dir, 'ic_launcher.png'));
  resize(legacyRound, Math.round(LEGACY_DP * scale), join(dir, 'ic_launcher_round.png'));
  resize(foreground, Math.round(ADAPTIVE_DP * scale), join(dir, 'ic_launcher_foreground.png'));
}

{
  // The planet is the artwork's outermost solid part; no launcher mask may clip it.
  const { planet } = trayShapes();
  const reach = Math.hypot(planet.cx - CENTRE, planet.cy - CENTRE) + planet.r;
  if (reach * (ADAPTIVE_VISIBLE_DP / ARTWORK) > ADAPTIVE_SAFE_DP / 2) {
    throw new Error("the artwork reaches past the adaptive icon's safe zone");
  }
}

// ---- iOS ------------------------------------------------------------------

// Opaque and square: App Store Connect refuses an icon with an alpha channel,
// and iOS rounds the corners itself. The JPEG round trip is what drops the
// alpha channel sips would otherwise keep.
{
  const square = join(work, 'ios.svg');
  writeFileSync(square, withViewBox(withoutBorder(withCornerRadius(favicon, 0)), 0, ARTWORK));
  qlmanage(IOS_PX, [square]);
  const jpeg = join(work, 'ios.jpg');
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', `${square}.png`, '--out', jpeg], { stdio: 'ignore' });
  execFileSync('sips', ['-z', String(IOS_PX), String(IOS_PX), '-s', 'format', 'png', jpeg, '--out', IOS_ICON], { stdio: 'ignore' });
}

// ---- launch screen --------------------------------------------------------

// PNGs, not a vector drawable: the mark's glow is a blur, which a vector
// drawable cannot draw. Android 12+ shows splash_mark as the system splash
// icon and drawable/splash.xml centres it on older versions; iOS centres the
// same canvas in LaunchScreen.storyboard.
{
  // qlmanage draws an SVG at its own width and height in the corner of the
  // thumbnail; without them it fills the thumbnail.
  const mark = readFileSync(SPLASH, 'utf8').replace(/(<svg[^>]*?)\s+width="[^"]*"\s+height="[^"]*"/, '$1');
  const box = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(mark);
  if (!box || box[1] !== box[2] || box[3] !== box[4]) throw new Error(`${SPLASH}: expected a square viewBox`);
  const [boxMin, boxSize] = [Number(box[1]), Number(box[3])];
  const unitsPerDp = boxSize / SPLASH_MARK_DP;
  const canvas = { size: SPLASH_CANVAS_DP * unitsPerDp, min: boxMin - ((SPLASH_CANVAS_DP - SPLASH_MARK_DP) * unitsPerDp) / 2 };

  // Nothing the mark draws may reach the circle Android 12 masks the icon to.
  const centre = boxMin + boxSize / 2;
  const reach = Math.max(...[...mark.matchAll(/<circle([^>]*)>/g)].map(([, a]) => {
    const num = (k) => Number(new RegExp(`\\b${k}="([\\d.]+)"`).exec(a)?.[1] ?? 0);
    return Math.hypot(num('cx') - centre, num('cy') - centre) + num('r') + num('stroke-width') / 2;
  }));
  if (reach / unitsPerDp > SPLASH_MASK_DP / 2) throw new Error("the splash mark reaches past Android's splash icon mask");

  const maxScale = Math.max(...Object.values(DENSITIES), ...IOS_SCALES);
  const splash = renderTransparent('splash', mark, canvas, SPLASH_CANVAS_DP * maxScale);
  for (const [bucket, scale] of Object.entries(DENSITIES)) {
    const dir = join(RES, `drawable-${bucket}`);
    mkdirSync(dir, { recursive: true });
    resize(splash, Math.round(SPLASH_CANVAS_DP * scale), join(dir, 'splash_mark.png'));
  }
  const images = IOS_SCALES.map((scale) => {
    const filename = scale === 1 ? 'splash.png' : `splash@${scale}x.png`;
    resize(splash, SPLASH_CANVAS_DP * scale, join(IOS_SPLASH, filename));
    return { idiom: 'universal', filename, scale: `${scale}x` };
  });
  writeFileSync(join(IOS_SPLASH, 'Contents.json'), `${JSON.stringify({ images, info: { version: 1, author: 'xcode' } }, null, 2)}\n`);
}

// ---- vector drawables -----------------------------------------------------

const fmt = (n) => String(Math.round(n * 1000) / 1000);

/** A circle as path data: two half arcs. */
function circlePath(cx, cy, r) {
  return `M${fmt(cx - r)},${fmt(cy)}a${fmt(r)},${fmt(r)} 0 1,0 ${fmt(2 * r)},0a${fmt(r)},${fmt(r)} 0 1,0 ${fmt(-2 * r)},0z`;
}

/** tray.svg's two circles: the ring (stroked) and the planet (filled). */
function trayShapes() {
  const circles = [...tray.matchAll(/<circle([^>]*)>/g)].map(([, a]) => {
    const num = (k) => Number(new RegExp(`\\b${k}="([\\d.]+)"`).exec(a)?.[1]);
    return { cx: num('cx'), cy: num('cy'), r: num('r'), stroke: num('stroke-width') };
  });
  const ring = circles.find((c) => c.stroke);
  const planet = circles.find((c) => !c.stroke);
  if (!ring || !planet) throw new Error(`${TRAY}: expected a stroked ring and a filled planet`);
  return { ring, planet };
}

/** White silhouette paths in tray.svg's coordinates. */
function silhouettePaths() {
  const { ring, planet } = trayShapes();
  return [
    `        <path android:pathData="${circlePath(ring.cx, ring.cy, ring.r)}"`,
    `            android:fillColor="#00000000" android:strokeColor="${WHITE}" android:strokeWidth="${ring.stroke}" />`,
    `        <path android:pathData="${circlePath(planet.cx, planet.cy, planet.r)}"`,
    `            android:fillColor="${WHITE}" />`,
  ].join('\n');
}

const GENERATED = '<!-- Generated by mobile/scripts/make-icons.mjs; do not edit by hand. -->';

function vector({ dp, viewport, translate, body }) {
  return `<?xml version="1.0" encoding="utf-8"?>
${GENERATED}
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${dp}dp"
    android:height="${dp}dp"
    android:viewportWidth="${fmt(viewport)}"
    android:viewportHeight="${fmt(viewport)}">
    <group android:translateX="${fmt(translate)}" android:translateY="${fmt(translate)}">
${body}
    </group>
</vector>
`;
}

// The notification small icon: Android draws only its alpha, tinted.
const trayViewBox = /viewBox="([\d.]+) [\d.]+ ([\d.]+)/.exec(tray);
writeFileSync(join(RES, 'drawable/ic_stat_orbital.xml'), vector({
  dp: STAT_DP, viewport: Number(trayViewBox[2]), translate: -Number(trayViewBox[1]), body: silhouettePaths(),
}));

// The themed icon's monochrome layer, placed exactly over the foreground.
writeFileSync(join(RES, 'drawable/ic_launcher_monochrome.xml'), vector({
  dp: ADAPTIVE_DP, viewport: adaptiveBox.size, translate: -adaptiveBox.min, body: silhouettePaths(),
}));

// The adaptive background: the tile's navy gradient and top sheen, in the
// favicon's own coordinates, so they land where the foreground expects them.
function stops(id) {
  const block = new RegExp(`<(linear|radial)Gradient id="${id}"([^>]*)>([\\s\\S]*?)</\\1Gradient>`).exec(favicon);
  if (!block) throw new Error(`${FAVICON}: no gradient #${id}`);
  const attr = (k) => Number(new RegExp(`\\b${k}="([\\d.]+)"`).exec(block[2])?.[1]);
  const items = [...block[3].matchAll(/<stop([^>]*)>/g)].map(([, a]) => {
    const offset = /offset="([\d.]+)"/.exec(a)[1];
    const colour = /stop-color="#([0-9a-f]{6})"/i.exec(a)[1];
    const opacity = Number(/stop-opacity="([\d.]+)"/.exec(a)?.[1] ?? 1);
    const alpha = Math.round(opacity * 255).toString(16).padStart(2, '0');
    return `                <item android:offset="${offset}" android:color="#${alpha}${colour}" />`;
  });
  return { attr, items: items.join('\n') };
}

const bg = stops('bg');
const sheen = stops('sheen');
// The whole canvas, bleed included: past the tile the gradients clamp to their end colours.
const tile = `M${fmt(adaptiveBox.min)},${fmt(adaptiveBox.min)}h${fmt(adaptiveBox.size)}v${fmt(adaptiveBox.size)}h${fmt(-adaptiveBox.size)}z`;
const background = `        <path android:pathData="${tile}">
            <aapt:attr name="android:fillColor">
                <gradient android:type="linear"
                    android:startX="${fmt(bg.attr('x1') * ARTWORK)}" android:startY="${fmt(bg.attr('y1') * ARTWORK)}"
                    android:endX="${fmt(bg.attr('x2') * ARTWORK)}" android:endY="${fmt(bg.attr('y2') * ARTWORK)}">
${bg.items}
                </gradient>
            </aapt:attr>
        </path>
        <path android:pathData="${tile}">
            <aapt:attr name="android:fillColor">
                <gradient android:type="radial"
                    android:centerX="${fmt(sheen.attr('cx') * ARTWORK)}" android:centerY="${fmt(sheen.attr('cy') * ARTWORK)}"
                    android:gradientRadius="${fmt(sheen.attr('r') * ARTWORK)}">
${sheen.items}
                </gradient>
            </aapt:attr>
        </path>`;
const backgroundXml = vector({ dp: ADAPTIVE_DP, viewport: adaptiveBox.size, translate: -adaptiveBox.min, body: background })
  .replace('<vector xmlns:android="http://schemas.android.com/apk/res/android"',
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:aapt="http://schemas.android.com/aapt"');
writeFileSync(join(RES, 'drawable/ic_launcher_background.xml'), backgroundXml);

// Capacitor's template drew its foreground as a vector too; ours is the PNG above.
const stale = join(RES, 'drawable-v24/ic_launcher_foreground.xml');
if (existsSync(stale)) unlinkSync(stale);

console.log(`wrote the launcher icons, ic_launcher_monochrome.xml and ic_stat_orbital.xml under ${RES}`);
console.log(`wrote ${IOS_ICON}`);
console.log(`wrote the splash marks: drawable-*/splash_mark.png and ${IOS_SPLASH}`);
