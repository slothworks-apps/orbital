/**
 * The PNG reading and writing the icon scripts share: mask-to-template.mjs
 * and unflatten.mjs. Only the one flavour this pipeline produces — 8-bit
 * RGBA, no interlacing — is handled.
 *
 * Node's zlib is all it needs, so no npm dependency is added for this.
 */

import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BIT_DEPTH_8 = 8;
const COLOUR_TYPE_RGBA = 6;
export const CHANNELS = 4;
export const OPAQUE = 255;

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
 * Anything other than 8-bit RGBA means qlmanage or sips changed its output,
 * which is worth an error rather than a silently wrong icon.
 */
export function decode(file) {
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

export function encode({ width, height, pixels }) {
  const stride = width * CHANNELS;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    // Filter 0 (none) throughout. These are checked-in assets written by hand
    // now and then, so the bytes a smarter filter would save are not worth the
    // code that picks one.
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
