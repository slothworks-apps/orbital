/**
 * A stored image brought down for the phone (spec
 * 2026-10-16-image-sizes-design § 2): a thumbnail in a transcript needs a
 * fraction of a full screenshot's bytes, and every byte crosses the relay.
 * `sharp` makes it, as WebP (ADR phone-thumbnails-are-webp-made-by-sharp);
 * where it cannot load, the phone gets the full image as before. Made once
 * per ref and edge, beside the store rather than in it (the store prunes
 * every file of its own directory), and never stale: a ref is its content's
 * hash. Thumbnails of images the store has pruned go with the first
 * thumbnail a process makes and every `SWEEP_EVERY` after it: the desktop
 * restarts on every update, so a count alone would seldom be reached.
 *
 * Only the raster formats in `THUMB_FORMATS` are decoded, under
 * `THUMB_MAX_INPUT_PIXELS` and `THUMB_TIMEOUT_S`, in this process: an SVG or
 * a small file that declares a huge image is sent whole rather than handed
 * to libvips. A failure to load `sharp`, to encode or to write is recorded
 * (ADR errors-are-recorded-not-announced) and the image is sent whole.
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

/**
 * The formats decoded, each by its magic bytes and again by what `sharp`
 * reads it as (it names AVIF `heif`): the raster ones a session's
 * screenshots come in. Anything else, SVG above all, is sent as it is.
 */
const THUMB_FORMATS = { png: 'png', jpeg: 'jpeg', gif: 'gif', webp: 'webp', avif: 'heif' } as const;
type ThumbFormat = keyof typeof THUMB_FORMATS;
/**
 * The most pixels an image may declare to be decoded: well above a
 * full-page screenshot, far below what a decompression bomb asks libvips to
 * hold. Read from the header before anything is decoded.
 */
export const THUMB_MAX_INPUT_PIXELS = 40_000_000;
/** How long one thumbnail may take to encode before it is given up. */
const THUMB_TIMEOUT_S = 10;

/** In flight per file, so two asks for one thumbnail encode once. */
const making = new Map<string, Promise<boolean>>();
/**
 * When each thumbnail that failed this process failed, so a broken image is
 * decoded and recorded once per `THUMB_RETRY_AFTER_MS` rather than on every
 * ask; emptied by `sweep`.
 */
const failed = new Map<string, number>();
/** How long a failed thumbnail is not tried again: a passing failure (a timeout under load) must not keep an image whole for long. */
export const THUMB_RETRY_AFTER_MS = 10 * 60 * 1000;
/** Thumbnails made between two sweeps for ones whose image is gone. */
const SWEEP_EVERY = 50;
/** Starts full, so the first thumbnail a process makes sweeps. */
let madeSinceSweep = SWEEP_EVERY - 1;

export type ThumbFailure = 'load' | 'encode' | 'write';
type ThumbRecorder = (during: ThumbFailure, err: unknown) => void;
let record: ThumbRecorder = (during, err) => {
  console.warn(`[thumbs] ${during} failed: ${err instanceof Error ? err.message : String(err)}`);
};

/** Where thumbnail failures go; the server hands its error log, before then they are only logged. */
export function recordThumbFailuresWith(recorder: ThumbRecorder): void {
  record = recorder;
}

function recordFailure(during: ThumbFailure, err: unknown): void {
  try {
    record(during, err);
  } catch {
    /* a recorder that throws must not take the image down with it */
  }
}

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
    const failedAt = failed.get(out);
    if (failedAt !== undefined && Date.now() - failedAt < THUMB_RETRY_AFTER_MS) return null;
    let running = making.get(out);
    if (!running) {
      running = job().then((made) => {
        if (!made) return false;
        try {
          writeFileSync(out, made);
        } catch (err) {
          failed.set(out, Date.now());
          recordFailure('write', err);
          return false;
        }
        if (++madeSinceSweep >= SWEEP_EVERY) {
          madeSinceSweep = 0;
          sweep(imagesDir);
        }
        return true;
      }, (err: unknown) => {
        failed.set(out, Date.now());
        recordFailure('encode', err);
        return false;
      });
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

function loadSharp(): Promise<typeof import('sharp').default | null> {
  sharpModule ??= import('sharp').then(
    (m) => {
      // Every thumbnail is encoded once and read from disk after: libvips's op cache would only hold memory.
      m.default.cache(false);
      return m.default;
    },
    (err: unknown) => {
      recordFailure('load', err);
      return null;
    },
  );
  return sharpModule;
}

/** Which of `THUMB_FORMATS` the bytes are, by their magic bytes; null for any other. */
function formatOf(bytes: Uint8Array): ThumbFormat | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 12));
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(b.toString('latin1', 8, 12))) return 'avif';
  return null;
}

/**
 * The WebP of `bytes` at `edge`, or null when it is not to be made (a format
 * not in `THUMB_FORMATS`, more than `THUMB_MAX_INPUT_PIXELS`, no `sharp`).
 * Throws when an image that should be made could not be.
 */
async function make(bytes: Uint8Array, dir: string, edge: number): Promise<Uint8Array | null> {
  const format = formatOf(bytes);
  if (!format) return null;
  const sharp = await loadSharp();
  if (!sharp) return null;
  // The header alone, so a declared size over the limit is refused before a pixel is decoded.
  const meta = await sharp(bytes, { limitInputPixels: false }).metadata();
  if (meta.format !== THUMB_FORMATS[format]) return null;
  if (!meta.width || !meta.height || meta.width * meta.height > THUMB_MAX_INPUT_PIXELS) return null;
  mkdirSync(dir, { recursive: true });
  // `rotate()` applies the EXIF orientation; `inside` fits the longest edge and never enlarges.
  return await sharp(bytes, { limitInputPixels: THUMB_MAX_INPUT_PIXELS })
    .timeout({ seconds: THUMB_TIMEOUT_S })
    .rotate()
    .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();
}

/**
 * Drops every thumbnail whose image the store no longer holds, every file
 * thumbnail past its age, and every one left in a format no longer made.
 */
export function sweep(imagesDir: string, now = Date.now()): void {
  failed.clear();
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
