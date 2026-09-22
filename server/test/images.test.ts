import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageStore } from '../src/images/store.js';

/**
 * Minimal-but-valid image headers, built by hand so the dimension sniffing
 * runs against real byte layouts, not fixtures nobody can read.
 */
function pngBytes(w: number, h: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([sig, ihdr]);
}

function gifBytes(w: number, h: number): Buffer {
  const b = Buffer.alloc(10);
  b.write('GIF89a', 0);
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

function jpegBytes(w: number, h: number): Buffer {
  // SOI, one APP0 to prove the scanner walks segments, then SOF0.
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(10);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(8, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([soi, app0, sof]);
}

function webpBytes(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0);
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8);
  b.write('VP8X', 12);
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbital-images-'));
});

describe('createImageStore', () => {
  it('stores by content hash with the extension the route serves', () => {
    const store = createImageStore(dir);
    const entry = store.put('image/png', pngBytes(320, 200).toString('base64'));
    expect(entry).not.toBeNull();
    expect(entry!.ref).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(readdirSync(dir)).toEqual([entry!.ref]);
  });

  it('is idempotent: the same bytes land as the same single file', () => {
    const store = createImageStore(dir);
    const b64 = pngBytes(320, 200).toString('base64');
    const first = store.put('image/png', b64);
    const second = store.put('image/png', b64);
    expect(second!.ref).toBe(first!.ref);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('maps image/jpeg to the jpg extension the route regex expects', () => {
    const store = createImageStore(dir);
    const entry = store.put('image/jpeg', jpegBytes(100, 50).toString('base64'));
    expect(entry!.ref.endsWith('.jpg')).toBe(true);
  });

  it('sniffs dimensions per format', () => {
    const store = createImageStore(dir);
    expect(store.put('image/png', pngBytes(1512, 982).toString('base64'))).toMatchObject({ w: 1512, h: 982 });
    expect(store.put('image/gif', gifBytes(640, 480).toString('base64'))).toMatchObject({ w: 640, h: 480 });
    expect(store.put('image/jpeg', jpegBytes(1280, 800).toString('base64'))).toMatchObject({ w: 1280, h: 800 });
    expect(store.put('image/webp', webpBytes(390, 844).toString('base64'))).toMatchObject({ w: 390, h: 844 });
  });

  it('reports the stored byte size', () => {
    const store = createImageStore(dir);
    const bytes = pngBytes(10, 10);
    expect(store.put('image/png', bytes.toString('base64'))!.bytes).toBe(bytes.length);
  });

  it('returns null dims for bytes its sniffer does not understand, but still stores', () => {
    const store = createImageStore(dir);
    const entry = store.put('image/png', Buffer.from('not really a png').toString('base64'));
    expect(entry).toMatchObject({ w: null, h: null });
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('rejects media types outside the whitelist', () => {
    const store = createImageStore(dir);
    expect(store.put('image/tiff', pngBytes(4, 4).toString('base64'))).toBeNull();
    expect(store.put('application/pdf', 'aGk=')).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('rejects empty or undecodable payloads', () => {
    const store = createImageStore(dir);
    expect(store.put('image/png', '')).toBeNull();
    expect(store.put('image/png', '%%%%')).toBeNull();
  });

  it('putBytes takes the buffer straight, and put lands on the same ref', () => {
    const store = createImageStore(dir);
    const bytes = pngBytes(64, 48);
    const viaBytes = store.putBytes('image/png', bytes);
    expect(viaBytes).toMatchObject({ w: 64, h: 48, bytes: bytes.length });
    expect(viaBytes!.ref).toMatch(/^[a-f0-9]{64}\.png$/);
    // The upload hop and the transcript hop are the same bytes, so they must
    // be the same file — the whole point of addressing by content.
    expect(store.put('image/png', bytes.toString('base64'))!.ref).toBe(viaBytes!.ref);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('putBytes refuses a media type outside the whitelist, and empty bytes', () => {
    const store = createImageStore(dir);
    expect(store.putBytes('application/pdf', Buffer.from('%PDF-1.4'))).toBeNull();
    expect(store.putBytes('image/png', Buffer.alloc(0))).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('read round-trips what putBytes stored, media type back from the extension', () => {
    const store = createImageStore(dir);
    const bytes = jpegBytes(200, 100);
    const entry = store.putBytes('image/jpeg', bytes)!;
    expect(store.read(entry.ref)).toEqual({
      mediaType: 'image/jpeg',
      base64: bytes.toString('base64'),
    });
  });

  it('read is null for a ref that names nothing, and for one that is not a ref at all', () => {
    const store = createImageStore(dir);
    expect(store.read(`${'a'.repeat(64)}.png`)).toBeNull();
    // The same shape guard the images route applies: neither traversal nor an
    // unlisted extension can name a file the store did not write.
    expect(store.read('../../etc/passwd')).toBeNull();
    expect(store.read('deadbeef.png')).toBeNull();
    expect(store.read(`${'a'.repeat(64)}.jpeg`)).toBeNull();
    expect(store.read('')).toBeNull();
  });

  it('read is null for a pruned ref rather than throwing', () => {
    const store = createImageStore(dir);
    const entry = store.putBytes('image/png', pngBytes(8, 8))!;
    rmSync(join(dir, entry.ref));
    expect(store.read(entry.ref)).toBeNull();
  });

  it('prunes oldest-by-mtime past the byte cap, never the file just written', () => {
    const store = createImageStore(dir, { maxBytes: 100 });
    const old = store.put('image/png', pngBytes(1, 1).toString('base64'))!;
    // Backdate so mtime ordering is unambiguous.
    utimesSync(join(dir, old.ref), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const mid = store.put('image/gif', gifBytes(2, 2).toString('base64'))!;
    utimesSync(join(dir, mid.ref), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    // 90 bytes of padding pushes the store over the 100-byte cap on write.
    const big = store.put('image/webp', Buffer.concat([webpBytes(3, 3), Buffer.alloc(60)]).toString('base64'))!;

    const left = readdirSync(dir);
    expect(left).toContain(big.ref);
    expect(left).not.toContain(old.ref);
  });
});
