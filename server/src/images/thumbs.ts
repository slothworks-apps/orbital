/**
 * A stored image brought down for the phone (spec
 * 2026-10-16-image-sizes-design § 2): a thumbnail in a transcript needs a
 * fraction of a full screenshot's bytes, and every byte crosses the relay.
 * macOS's own `sips` does the work, so nothing is added to the app; where it
 * is missing (a server on Linux) the phone gets the full image as before.
 * Made once per ref and edge, beside the store rather than in it (the store
 * prunes every file of its own directory), and never stale: a ref is its
 * content's hash. Thumbnails of images the store has pruned go every
 * `SWEEP_EVERY` thumbnails made.
 *
 * A file a session names by path is brought down the same way
 * (`thumbnailOfBytes`), kept by its content's hash in a directory of its
 * own: no store says when such a file is gone, so its thumbnails go once
 * `FILE_THUMB_MAX_AGE_MS` old.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The edges a phone may ask for; anything else is not made, so the cache cannot be filled with sizes. */
export const THUMB_EDGES: readonly number[] = [512, 1024];
/** A thumbnail is JPEG: a screenshot's flat colours survive it, and it is a tenth of the PNG. */
const THUMB_QUALITY = '80';

export type Thumb = { bytes: Uint8Array; mediaType: string };

/** In flight per file, so two asks for one thumbnail run `sips` once. */
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
 * The thumbnail of `ref` at `edge`, or null: an edge not offered, no `sips`,
 * or a thumbnail no smaller than the image itself (then the image is sent).
 */
export async function thumbnailOf(imagesDir: string, ref: string, edge: number): Promise<Thumb | null> {
  if (!THUMB_EDGES.includes(edge) || !/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(ref)) return null;
  const source = join(imagesDir, ref);
  if (!existsSync(source)) return null;
  const dir = join(thumbsDir(imagesDir), String(edge));
  const out = join(dir, `${ref.slice(0, 64)}.jpg`);
  let size: number;
  try {
    size = statSync(source).size;
  } catch {
    return null;
  }
  return thumbAt(imagesDir, out, size, () => make(source, dir, out, edge));
}

/**
 * The thumbnail of a file named by path, from its bytes, at `edge`; null as
 * for `thumbnailOf`. The bytes go to disk only while `sips` reads them.
 */
export async function thumbnailOfBytes(imagesDir: string, bytes: Uint8Array, edge: number): Promise<Thumb | null> {
  if (!THUMB_EDGES.includes(edge)) return null;
  const dir = join(fileThumbsDir(imagesDir), String(edge));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const out = join(dir, `${hash}.jpg`);
  return thumbAt(imagesDir, out, bytes.length, async () => {
    const source = join(dir, `${hash}.src`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(source, bytes);
      return await make(source, dir, out, edge);
    } catch {
      return false;
    } finally {
      rmSync(source, { force: true });
    }
  });
}

/** `out`, made by `job` once however many ask, unless it is no smaller than the `size` it stands for. */
async function thumbAt(imagesDir: string, out: string, size: number, job: () => Promise<boolean>): Promise<Thumb | null> {
  if (!existsSync(out)) {
    let running = making.get(out);
    if (!running) {
      running = job().then((made) => {
        if (made && ++madeSinceSweep >= SWEEP_EVERY) {
          madeSinceSweep = 0;
          sweep(imagesDir);
        }
        return made;
      });
      making.set(out, running);
      void running.finally(() => making.delete(out));
    }
    if (!(await running)) return null;
  }
  try {
    if (statSync(out).size >= size) return null;
    return { bytes: new Uint8Array(readFileSync(out)), mediaType: 'image/jpeg' };
  } catch {
    return null;
  }
}

async function make(source: string, dir: string, out: string, edge: number): Promise<boolean> {
  try {
    mkdirSync(dir, { recursive: true });
    // `-Z` fits the longest edge and never enlarges.
    await run('sips', ['-Z', String(edge), '-s', 'format', 'jpeg', '-s', 'formatOptions', THUMB_QUALITY, source, '--out', out], {
      timeout: 15_000,
    });
    return existsSync(out);
  } catch {
    return false;
  }
}

/** Drops every thumbnail whose image the store no longer holds, and every file thumbnail past its age. */
export function sweep(imagesDir: string, now = Date.now()): void {
  try {
    for (const edge of readdirSync(fileThumbsDir(imagesDir))) {
      const dir = join(fileThumbsDir(imagesDir), edge);
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (now - statSync(file).mtimeMs > FILE_THUMB_MAX_AGE_MS) rmSync(file, { force: true });
      }
    }
  } catch {
    /* none made yet, or a file gone meanwhile: the next sweep */
  }
  try {
    const kept = new Set(readdirSync(imagesDir).map((name) => name.slice(0, 64)));
    for (const edge of readdirSync(thumbsDir(imagesDir))) {
      const dir = join(thumbsDir(imagesDir), edge);
      for (const name of readdirSync(dir)) if (!kept.has(name.slice(0, 64))) rmSync(join(dir, name), { force: true });
    }
  } catch {
    /* nothing made yet, or a file gone meanwhile: the next sweep */
  }
}
