import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Content-addressed image store (spec: 2026-09-18-transcript-images-design).
 *
 * Transcript image blocks are decoded exactly once, here; Orbital's own wire
 * then carries only `ImageRefEntry` — never base64. The hash IS the id, so
 * the same screenshot pasted twice (or a tool reading one image three
 * times) is a single file, and `GET /api/images/:ref` can honestly answer
 * `Cache-Control: immutable`.
 */

import type { ImageRefEntry } from '../types.js';

export type { ImageRefEntry };

export interface ImageStore {
  put(mediaType: string, base64: string): ImageRefEntry | null;
}

/** Cap in the errors-table spirit: the store must not grow forever. */
export const IMAGE_STORE_MAX_BYTES = 512 * 1024 * 1024;

/** Media types worth storing; the extension is what the route regex serves
 * (`jpg`, deliberately not `jpeg`). */
const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function pngDims(b: Buffer): [number, number] | null {
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function gifDims(b: Buffer): [number, number] | null {
  if (b.length < 10) return null;
  const sig = b.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return [b.readUInt16LE(6), b.readUInt16LE(8)];
}

function jpegDims(b: Buffer): [number, number] | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  // Walk marker segments until a start-of-frame carries the dimensions.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    // SOF0–SOF15, minus the DHT/JPG/DAC markers interleaved in that range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function webpDims(b: Buffer): [number, number] | null {
  if (b.length < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  if (chunk === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (chunk === 'VP8L') {
    const n = b.readUInt32LE(21);
    return [(n & 0x3fff) + 1, ((n >> 14) & 0x3fff) + 1];
  }
  return null;
}

function sniffDims(bytes: Buffer): [number, number] | null {
  return pngDims(bytes) ?? gifDims(bytes) ?? jpegDims(bytes) ?? webpDims(bytes);
}

export function createImageStore(
  dir: string,
  opts: { maxBytes?: number } = {},
): ImageStore {
  const maxBytes = opts.maxBytes ?? IMAGE_STORE_MAX_BYTES;
  mkdirSync(dir, { recursive: true });

  function prune(keep: string) {
    const files = readdirSync(dir).map((name) => {
      const st = statSync(join(dir, name));
      return { name, size: st.size, mtimeMs: st.mtimeMs };
    });
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= maxBytes) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files) {
      if (total <= maxBytes) break;
      // The file just written is the newest and never the right victim —
      // pruning it would turn the put into a silent no-op.
      if (f.name === keep) continue;
      rmSync(join(dir, f.name), { force: true });
      total -= f.size;
    }
  }

  return {
    put(mediaType, base64) {
      const ext = EXT[mediaType];
      if (!ext) return null;
      // Buffer.from silently skips invalid characters, so validate first —
      // '%%%%' must be a rejection, not a zero-byte file.
      if (!base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64)) return null;
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0) return null;

      const ref = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
      try {
        writeFileSync(join(dir, ref), bytes, { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      prune(ref);

      const dims = sniffDims(bytes);
      return { ref, w: dims?.[0] ?? null, h: dims?.[1] ?? null, bytes: bytes.length };
    },
  };
}
