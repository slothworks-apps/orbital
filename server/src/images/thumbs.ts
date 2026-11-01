/**
 * A stored image brought down for the phone (spec
 * 2026-10-16-image-sizes-design § 2): a thumbnail in a transcript needs a
 * fraction of a full screenshot's bytes, and every byte crosses the relay.
 * `sharp` makes it, as WebP (ADR phone-thumbnails-are-webp-made-by-sharp);
 * where it cannot load, the phone gets the full image as before. Made once
 * per ref and edge, beside the store rather than in it (the store prunes
 * every file of its own directory), and never stale: a ref is its content's
 * hash. Thumbnails of images the store has pruned go every `SWEEP_EVERY`
 * thumbnails made.
 *
 * A file a session names by path is brought down the same way
 * (`thumbnailOfBytes`), kept by its content's hash in a directory of its
 * own: no store says when such a file is gone, so its thumbnails go once
 * `FILE_THUMB_MAX_AGE_MS` old.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The edges a phone may ask for; anything else is not made, so the cache cannot be filled with sizes. */
export const THUMB_EDGES: readonly number[] = [512, 1024];
/** WebP keeps a screenshot's text and transparency at a third of a JPEG's bytes. */
const THUMB_QUALITY = 80;
const THUMB_EXT = '.webp';

export type Thumb = { bytes: Uint8Array; mediaType: string };

/** In flight per file, so two asks for one thumbnail encode once. */
const making = new Map<string, Promise<boolean>>();
/** Thumbnails made between two sweeps for ones whose image is gone. */
const SWEEP_EVERY = 50;
let madeSinceSweep = 0;
/** How long a thumbnail of a file named by path is kept after it was made. */
export const FILE_THUMB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Where the thumbnails of the store in `imagesDir` live. */
export function thumbsDir(imagesDir: string): string {
  return `${resolve(imagesDir)}-thumbs`;
}

/** Where the thumbnails of files named by path live, beside the store's. */
export function fileThumbsDir(imagesDir: string): string {
  return `${resolve(imagesDir)}-file-thumbs`;
}

/**
 * The thumbnail of `ref` at `edge`, or null: an edge not offered, no
 * `sharp`, or a thumbnail no smaller than the image itself (then the image
 * is sent).
 */
export async function thumbnailOf(imagesDir: string, ref: string, edge: number): Promise<Thumb | null> {
  if (!THUMB_EDGES.includes(edge) || !/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(ref)) return null;
  const source = join(imagesDir, ref);
  let size: number;
  try {
    size = statSync(source).size;
  } catch {
    return null;
  }
  const dir = join(thumbsDir(imagesDir), String(edge));
  return thumbAt(imagesDir, join(dir, `${ref.slice(0, 64)}${THUMB_EXT}`), size, () => make(readFileSync(source), dir, edge));
}

/** The thumbnail of a file named by path, from its bytes, at `edge`; null as for `thumbnailOf`. */
export async function thumbnailOfBytes(imagesDir: string, bytes: Uint8Array, edge: number): Promise<Thumb | null> {
  if (!THUMB_EDGES.includes(edge)) return null;
  const dir = join(fileThumbsDir(imagesDir), String(edge));
  const hash = createHash('sha256').update(bytes).digest('hex');
  return thumbAt(imagesDir, join(dir, `${hash}${THUMB_EXT}`), bytes.length, () => make(bytes, dir, edge));
}

/** `out`, made by `job` once however many ask, unless it is no smaller than the `size` it stands for. */
async function thumbAt(
  imagesDir: string, out: string, size: number, job: () => Promise<Uint8Array | null>,
): Promise<Thumb | null> {
  if (!existsSync(out)) {
    let running = making.get(out);
    if (!running) {
      running = job().then((made) => {
        if (!made) return false;
        writeFileSync(out, made);
        if (++madeSinceSweep >= SWEEP_EVERY) {
          madeSinceSweep = 0;
          sweep(imagesDir);
        }
        return true;
      }).catch(() => false);
      making.set(out, running);
      void running.finally(() => making.delete(out));
    }
    if (!(await running)) return null;
  }
  try {
    if (statSync(out).size >= size) return null;
    return { bytes: new Uint8Array(readFileSync(out)), mediaType: 'image/webp' };
  } catch {
    return null;
  }
}

/** Loaded on first use, so a server whose `sharp` cannot load still starts and sends images whole. */
let sharpModule: Promise<typeof import('sharp').default | null> | null = null;

async function make(bytes: Uint8Array, dir: string, edge: number): Promise<Uint8Array | null> {
  sharpModule ??= import('sharp').then((m) => m.default, () => null);
  const sharp = await sharpModule;
  if (!sharp) return null;
  try {
    mkdirSync(dir, { recursive: true });
    // `rotate()` applies the EXIF orientation; `inside` fits the longest edge and never enlarges.
    return await sharp(bytes)
      .rotate()
      .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Drops every thumbnail whose image the store no longer holds, every file
 * thumbnail past its age, and every one left in a format no longer made.
 */
export function sweep(imagesDir: string, now = Date.now()): void {
  try {
    for (const edge of readdirSync(fileThumbsDir(imagesDir))) {
      const dir = join(fileThumbsDir(imagesDir), edge);
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (!name.endsWith(THUMB_EXT) || now - statSync(file).mtimeMs > FILE_THUMB_MAX_AGE_MS) rmSync(file, { force: true });
      }
    }
  } catch {
    /* none made yet, or a file gone meanwhile: the next sweep */
  }
  try {
    const kept = new Set(readdirSync(imagesDir).map((name) => name.slice(0, 64)));
    for (const edge of readdirSync(thumbsDir(imagesDir))) {
      const dir = join(thumbsDir(imagesDir), edge);
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(THUMB_EXT) || !kept.has(name.slice(0, 64))) rmSync(join(dir, name), { force: true });
      }
    }
  } catch {
    /* nothing made yet, or a file gone meanwhile: the next sweep */
  }
}
