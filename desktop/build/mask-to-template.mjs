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
 * Node's zlib is all it needs, so no npm dependency is added for this either.
 *
 * Usage: node mask-to-template.mjs <in.png> <out.png>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BIT_DEPTH_8 = 8;
const COLOUR_TYPE_RGBA = 6;
const CHANNELS = 4;
const OPAQUE = 255;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode the one PNG flavour this pipeline produces: 8-bit RGBA, no
 * interlacing. Anything else means sips changed its output, which is worth an
 * error rather than a silently wrong icon.
 */
function decode(file) {
  const buf = readFileSync(file);
  if (!buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${file} is not a PNG`);
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  const parts = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== BIT_DEPTH_8 || colour !== COLOUR_TYPE_RGBA || interlace !== 0) {
        throw new Error(`${file}: expected 8-bit RGBA, got depth ${depth} colour ${colour}`);
      }
    }
    if (type === 'IDAT') parts.push(data);
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * CHANNELS;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= CHANNELS ? pixels[y * stride + x - CHANNELS] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= CHANNELS && y > 0 ? pixels[(y - 1) * stride + x - CHANNELS] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

function encode({ width, height, pixels }) {
  const stride = width * CHANNELS;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    // Filter 0 (none) throughout: these images are 32 pixels at most, so the
    // bytes a smarter filter would save are not worth the code that finds it.
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = BIT_DEPTH_8;
  ihdr[9] = COLOUR_TYPE_RGBA;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
