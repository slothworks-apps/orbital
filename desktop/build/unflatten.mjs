/**
 * Recovers a transparent PNG from two opaque renders of the same drawing, one
 * over white and one over black.
 *
 * qlmanage flattens transparency onto white, which gave the app icon white
 * corners around its rounded tile. A pixel with colour C and alpha a comes out
 * as a·C + (1−a)·255 over white and a·C over black, so their difference is
 * (1−a)·255 — the alpha — and the black render divided by it is the colour.
 *
 * Usage: node unflatten.mjs <on-white.png> <on-black.png> <out.png>
 */

import { writeFileSync } from 'node:fs';
import { CHANNELS, OPAQUE, decode, encode } from './png.mjs';

const [onWhite, onBlack, output] = process.argv.slice(2);
if (!onWhite || !onBlack || !output) {
  console.error('usage: node unflatten.mjs <on-white.png> <on-black.png> <out.png>');
  process.exit(1);
}

const white = decode(onWhite);
const black = decode(onBlack);
if (white.width !== black.width || white.height !== black.height) {
  throw new Error(`${onWhite} and ${onBlack} differ in size`);
}

const out = Buffer.alloc(black.pixels.length);
for (let i = 0; i < out.length; i += CHANNELS) {
  // Each channel gives its own estimate of the alpha; their mean averages
  // out the renderer's rounding.
  let spread = 0;
  for (let c = 0; c < 3; c++) spread += white.pixels[i + c] - black.pixels[i + c];
  const alpha = Math.min(OPAQUE, Math.max(0, Math.round(OPAQUE - spread / 3)));
  for (let c = 0; c < 3; c++) {
    out[i + c] = alpha === 0 ? 0 : Math.min(OPAQUE, Math.round((black.pixels[i + c] * OPAQUE) / alpha));
  }
  out[i + 3] = alpha;
}
writeFileSync(output, encode({ width: black.width, height: black.height, pixels: out }));
console.log(`wrote ${output}`);
