import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  FILE_THUMB_MAX_AGE_MS, THUMB_EDGES, fileThumbsDir, sweep, thumbnailOf, thumbnailOfBytes, thumbsDir,
} from '../src/images/thumbs.js';
import { makeTmpDir } from './tmp.js';

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
  it('brings a large image down to a smaller WebP, made once', async () => {
    const { dir, ref } = store(png(2400, 1600));
    const thumb = await thumbnailOf(dir, ref, 1024);
    expect(thumb?.mediaType).toBe('image/webp');
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

  it('drops a thumbnail left in a format no longer made', async () => {
    const { dir, ref } = store(png(2400, 1600));
    await thumbnailOf(dir, ref, 512);
    const old = join(thumbsDir(dir), '512', `${ref.slice(0, 64)}.jpg`);
    writeFileSync(old, 'jpeg');
    sweep(dir);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(thumbsDir(dir), '512', `${ref.slice(0, 64)}.webp`))).toBe(true);
  });

  it('drops the thumbnail of an image the store has pruned', async () => {
    const { dir, ref } = store(png(2400, 1600));
    await thumbnailOf(dir, ref, 512);
    const made = join(thumbsDir(dir), '512', `${ref.slice(0, 64)}.webp`);
    expect(existsSync(made)).toBe(true);
    rmSync(join(dir, ref));
    sweep(dir);
    expect(existsSync(made)).toBe(false);
  });

  it('sends the image itself when the thumbnail would be no smaller', async () => {
    // A 1×1 GIF is 43 bytes; no WebP of it is smaller.
    const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
    const dir = makeTmpDir('thumbs');
    const ref = `${createHash('sha256').update(gif).digest('hex')}.gif`;
    writeFileSync(join(dir, ref), gif);
    expect(await thumbnailOf(dir, ref, 512)).toBeNull();
  });
});

describe('thumbnails of files named by path', () => {
  it('brings a file down from its bytes, made once', async () => {
    const dir = makeTmpDir('file-thumbs');
    const bytes = png(2400, 1600);
    const thumb = await thumbnailOfBytes(dir, bytes, 512);
    expect(thumb?.mediaType).toBe('image/webp');
    expect(thumb!.bytes.length).toBeLessThan(bytes.length);
    expect(readdirSync(join(fileThumbsDir(dir), '512'))).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.webp$/)]);
    expect((await thumbnailOfBytes(dir, bytes, 512))?.bytes.length).toBe(thumb!.bytes.length);
  });

  it('makes none at an edge it does not offer, or of bytes that are no image', async () => {
    const dir = makeTmpDir('file-thumbs');
    expect(await thumbnailOfBytes(dir, png(64, 64), 333)).toBeNull();
    expect(await thumbnailOfBytes(dir, Buffer.from('not an image'), 512)).toBeNull();
  });

  it('drops a file thumbnail once it is past its age', async () => {
    const dir = makeTmpDir('file-thumbs');
    await thumbnailOfBytes(dir, png(2400, 1600), 512);
    const [name] = readdirSync(join(fileThumbsDir(dir), '512'));
    const made = join(fileThumbsDir(dir), '512', name);
    sweep(dir);
    expect(existsSync(made)).toBe(true);
    const old = (Date.now() - FILE_THUMB_MAX_AGE_MS - 1000) / 1000;
    utimesSync(made, old, old);
    sweep(dir);
    expect(existsSync(made)).toBe(false);
  });
});
