import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { THUMB_EDGES, sweep, thumbnailOf, thumbsDir } from '../src/images/thumbs.js';
import { makeTmpDir } from './tmp.js';

const hasSips = (() => {
  try {
    execFileSync('which', ['sips']);
    return true;
  } catch {
    return false;
  }
})();

/** A noisy RGB PNG, so it weighs what a real screenshot does. */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = randomBytes((w * 3 + 1) * h);
  for (let row = 0; row < h; row++) raw[row * (w * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function store(bytes: Buffer): { dir: string; ref: string } {
  const dir = makeTmpDir('thumbs');
  const ref = `${createHash('sha256').update(bytes).digest('hex')}.png`;
  writeFileSync(join(dir, ref), bytes);
  return { dir, ref };
}

describe('thumbnails for the phone', () => {
  it.skipIf(!hasSips)('brings a large image down to a smaller JPEG, made once', async () => {
    const { dir, ref } = store(png(2400, 1600));
    const thumb = await thumbnailOf(dir, ref, 1024);
    expect(thumb?.mediaType).toBe('image/jpeg');
    expect(thumb!.bytes.length).toBeGreaterThan(0);
    const again = await thumbnailOf(dir, ref, 1024);
    expect(again?.bytes.length).toBe(thumb!.bytes.length);
  });

  it('makes no thumbnail at an edge it does not offer, or of a ref that is not one', async () => {
    const { dir, ref } = store(png(64, 64));
    expect(THUMB_EDGES).not.toContain(333);
    expect(await thumbnailOf(dir, ref, 333)).toBeNull();
    expect(await thumbnailOf(dir, '../x.png', 1024)).toBeNull();
  });

  it.skipIf(!hasSips)('drops the thumbnail of an image the store has pruned', async () => {
    const { dir, ref } = store(png(2400, 1600));
    await thumbnailOf(dir, ref, 512);
    const made = join(thumbsDir(dir), '512', `${ref.slice(0, 64)}.jpg`);
    expect(existsSync(made)).toBe(true);
    rmSync(join(dir, ref));
    sweep(dir);
    expect(existsSync(made)).toBe(false);
  });

  it.skipIf(!hasSips)('sends the image itself when the thumbnail would be no smaller', async () => {
    const { dir, ref } = store(png(16, 16));
    expect(await thumbnailOf(dir, ref, 512)).toBeNull();
  });
});
