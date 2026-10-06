import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  /**
   * The same store entry from bytes rather than base64 — what a composer
   * upload arrives as (`POST /api/sessions/:id/attachments`). `put` decodes
   * and delegates here, so a screenshot pasted into the composer and the same
   * screenshot read back out of a transcript are one file.
   */
  putBytes(mediaType: string, bytes: Buffer): ImageRefEntry | null;
  /**
   * Reads a stored image back out for the one hop that needs base64 again:
   * the SDK user message an attachment rides in on. Null for a ref that names
   * nothing — a pruned attachment is skipped, never an error.
   */
  read(ref: string): { mediaType: string; base64: string } | null;
  /**
   * A stored image's wire entry by its ref — what a sent turn is published
   * with, so the sender's own copy and every other window's carry the same
   * images. Null for a ref that names nothing, as `read`.
   */
  entry(ref: string): ImageRefEntry | null;
}

/**
 * The half of the store the transcript path needs. Reading a transcript only
 * ever *puts* images — `read` and `putBytes` belong to the composer's upload
 * and send hops — so the parser asks for no more than it uses.
 */
export type ImageWriter = Pick<ImageStore, 'put'>;

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

/** `EXT` read the other way, for `read()`: the stored name is all that is left
 * of what was uploaded, so the extension is what names the media type again. */
const MEDIA_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(EXT).map(([mediaType, ext]) => [ext, mediaType]),
);

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

/** An image's pixel size from its header (PNG, GIF, JPEG, WebP), or null when it gives none. */
export function sniffDims(bytes: Buffer): [number, number] | null {
  return pngDims(bytes) ?? gifDims(bytes) ?? jpegDims(bytes) ?? webpDims(bytes);
}

export function createImageStore(
  dir: string,
  opts: { maxBytes?: number } = {},
): ImageStore {
  const maxBytes = opts.maxBytes ?? IMAGE_STORE_MAX_BYTES;
  mkdirSync(dir, { recursive: true });

  /**
   * Bytes in the directory, or null until the first write asks. Kept in
   * memory so a put does not list and stat the whole directory; `prune`
   * re-measures from disk whenever it runs, which also corrects any drift
   * (a file removed behind the store's back).
   */
  let total: number | null = null;

  function measure(): { name: string; size: number; mtimeMs: number }[] {
    return readdirSync(dir).map((name) => {
      const st = statSync(join(dir, name));
      return { name, size: st.size, mtimeMs: st.mtimeMs };
    });
  }

  function prune(keep: string) {
    const files = measure();
    let bytes = files.reduce((sum, f) => sum + f.size, 0);
    if (bytes > maxBytes) {
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of files) {
        if (bytes <= maxBytes) break;
        // The file just written is the newest and never the right victim —
        // pruning it would turn the put into a silent no-op.
        if (f.name === keep) continue;
        rmSync(join(dir, f.name), { force: true });
        bytes -= f.size;
      }
    }
    total = bytes;
  }

  const store: ImageStore = {
    putBytes(mediaType, bytes) {
      const ext = EXT[mediaType];
      if (!ext) return null;
      if (bytes.length === 0) return null;

      const ref = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
      let written = true;
      try {
        writeFileSync(join(dir, ref), bytes, { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Already stored, so the directory did not grow and there is nothing
        // to prune. A reloaded transcript's images all land here.
        written = false;
      }
      if (written) {
        // The first write measures the directory (inside `prune`); after that
        // the running total decides whether pruning has anything to do.
        if (total === null) prune(ref);
        else if ((total += bytes.length) > maxBytes) prune(ref);
      }

      const dims = sniffDims(bytes);
      return { ref, w: dims?.[0] ?? null, h: dims?.[1] ?? null, bytes: bytes.length };
    },

    put(mediaType, base64) {
      // Buffer.from silently skips invalid characters, so validate first —
      // '%%%%' must be a rejection, not a zero-byte file.
      if (!base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64)) return null;
      return store.putBytes(mediaType, Buffer.from(base64, 'base64'));
    },

    read(ref) {
      const stored = readStored(ref);
      return stored ? { mediaType: stored.mediaType, base64: stored.bytes.toString('base64') } : null;
    },

    entry(ref) {
      const stored = readStored(ref);
      if (!stored) return null;
      const dims = sniffDims(stored.bytes);
      return { ref, w: dims?.[0] ?? null, h: dims?.[1] ?? null, bytes: stored.bytes.length };
    },
  };

  /** A stored image's bytes and media type, or null for a ref that names nothing. */
  function readStored(ref: string): { mediaType: string; bytes: Buffer } | null {
    // The same shape guard `GET /api/images/:ref` applies, for the same
    // reason: 64 hex chars plus a whitelisted extension can neither
    // traverse nor name anything this store did not write.
    const match = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.exec(ref);
    if (!match) return null;
    try {
      return { mediaType: MEDIA_TYPE[match[1]], bytes: readFileSync(join(dir, ref)) };
    } catch {
      // Pruned — the caller drops the attachment rather than failing a turn.
      return null;
    }
  }

  return store;
}
