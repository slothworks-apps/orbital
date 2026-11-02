import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  FILE_THUMB_MAX_AGE_MS, THUMB_EDGES, THUMB_MAX_INPUT_PIXELS, THUMB_RETRY_AFTER_MS, fileThumbsDir, recordThumbFailuresWith, sweep,
  thumbnailOf, thumbnailOfBytes, thumbsDir,
} from '../src/images/thumbs.js';
import { makeTmpDir } from './tmp.js';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}

/** An RGB PNG of `w`×`h` whose pixel data is `raw`, deflated. */
function pngOf(w: number, h: number, raw: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A noisy RGB PNG, so it weighs what a real screenshot does. */
function png(w: number, h: number): Buffer {
  const raw = randomBytes((w * 3 + 1) * h);
  for (let row = 0; row < h; row++) raw[row * (w * 3 + 1)] = 0;
  return pngOf(w, h, raw);
}

/** A valid PNG header declaring `w`×`h`, over pixel data far too short for it. */
function pngClaiming(w: number, h: number): Buffer {
  return pngOf(w, h, randomBytes(4096));
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

describe('what is not thumbnailed', () => {
  afterEach(() => recordThumbFailuresWith(() => {}));

  it('sends an SVG whole: it is never handed to sharp', async () => {
    const dir = makeTmpDir('file-thumbs');
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000">${' '.repeat(100_000)}</svg>`);
    expect(await thumbnailOfBytes(dir, svg, 512)).toBeNull();
    expect(existsSync(fileThumbsDir(dir))).toBe(false);
  });

  it('sends whole an image that declares more pixels than the limit, without decoding or recording it', async () => {
    const recorded = vi.fn();
    recordThumbFailuresWith(recorded);
    const dir = makeTmpDir('file-thumbs');
    expect(await thumbnailOfBytes(dir, pngClaiming(THUMB_MAX_INPUT_PIXELS + 1, 1), 512)).toBeNull();
    expect(recorded).not.toHaveBeenCalled();
    // The same short pixel data under the limit is decoded, fails, and is recorded: the limit is what spared it.
    expect(await thumbnailOfBytes(dir, pngClaiming(THUMB_MAX_INPUT_PIXELS, 1), 512)).toBeNull();
    expect(recorded).toHaveBeenCalledWith('encode', expect.any(Error));
  });

  it('records a broken image once, however often it is asked for', async () => {
    const recorded = vi.fn();
    recordThumbFailuresWith(recorded);
    const dir = makeTmpDir('file-thumbs');
    const broken = pngClaiming(2400, 1600);
    expect(await thumbnailOfBytes(dir, broken, 512)).toBeNull();
    expect(await thumbnailOfBytes(dir, broken, 512)).toBeNull();
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveBeenCalledWith('encode', expect.any(Error));
  });
});

describe('a failed thumbnail', () => {
  afterEach(() => {
    vi.useRealTimers();
    recordThumbFailuresWith(() => {});
  });

  it('is tried again once THUMB_RETRY_AFTER_MS has passed, and recorded once per try', async () => {
    // Only the clock: sharp's own timers and promises run as they do.
    vi.useFakeTimers({ toFake: ['Date'] });
    const recorded = vi.fn();
    recordThumbFailuresWith(recorded);
    const dir = makeTmpDir('file-thumbs');
    const broken = pngClaiming(2400, 1600);
    await thumbnailOfBytes(dir, broken, 512);
    vi.setSystemTime(Date.now() + THUMB_RETRY_AFTER_MS - 1000);
    await thumbnailOfBytes(dir, broken, 512);
    expect(recorded).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2000);
    await thumbnailOfBytes(dir, broken, 512);
    await thumbnailOfBytes(dir, broken, 512);
    expect(recorded).toHaveBeenCalledTimes(2);
  });
});

describe('the sweep', () => {
  it('runs with the first thumbnail a process makes', async () => {
    vi.resetModules();
    const fresh = await import('../src/images/thumbs.js');
    const dir = makeTmpDir('file-thumbs');
    const stale = join(fresh.fileThumbsDir(dir), '512', `${'a'.repeat(64)}.webp`);
    mkdirSync(join(fresh.fileThumbsDir(dir), '512'), { recursive: true });
    writeFileSync(stale, 'old');
    const old = (Date.now() - fresh.FILE_THUMB_MAX_AGE_MS - 1000) / 1000;
    utimesSync(stale, old, old);
    expect(await fresh.thumbnailOfBytes(dir, png(2400, 1600), 512)).not.toBeNull();
    expect(existsSync(stale)).toBe(false);
  });
});
