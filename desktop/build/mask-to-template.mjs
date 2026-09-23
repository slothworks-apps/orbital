/**
 * Turns an opaque black-on-white render into a macOS template image: pure
 * black pixels whose alpha carries the ink, which is the only channel the menu
 * bar reads (spec: 2026-09-22-desktop-background-mode-design).
 *
 * It exists because qlmanage — the SVG renderer make-icon.sh already uses, and
 * the only one on a stock macOS — flattens transparency onto white. A
 * black-on-white render is that same shape with the alpha written into the
 * colour channels instead, so recovering it is one subtraction per pixel.
 *
 * Usage: node mask-to-template.mjs <in.png> <out.png>
 */

import { writeFileSync } from 'node:fs';
import { CHANNELS, OPAQUE, decode, encode } from './png.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node mask-to-template.mjs <in.png> <out.png>');
  process.exit(1);
}

const image = decode(input);
for (let i = 0; i < image.pixels.length; i += CHANNELS) {
  // The render is greyscale, so any channel is the luminance; white is paper
  // and black is ink, which is the alpha the menu bar wants.
  const alpha = OPAQUE - image.pixels[i];
  image.pixels[i] = 0;
  image.pixels[i + 1] = 0;
  image.pixels[i + 2] = 0;
  image.pixels[i + 3] = alpha;
}
writeFileSync(output, encode(image));
console.log(`wrote ${output}`);
