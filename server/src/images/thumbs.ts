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
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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

/** Where the thumbnails of the store in `imagesDir` live. */
export function thumbsDir(imagesDir: string): string {
  return `${resolve(imagesDir)}-thumbs`;
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
  if (!existsSync(out)) {
    let job = making.get(out);
    if (!job) {
      job = make(source, dir, out, edge).then((made) => {
        if (made && ++madeSinceSweep >= SWEEP_EVERY) {
          madeSinceSweep = 0;
          sweep(imagesDir);
        }
        return made;
      });
      making.set(out, job);
      void job.finally(() => making.delete(out));
    }
    if (!(await job)) return null;
  }
  try {
    if (statSync(out).size >= statSync(source).size) return null;
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

/** Drops every thumbnail whose image the store no longer holds. */
export function sweep(imagesDir: string): void {
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
