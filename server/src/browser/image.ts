/**
 * A screenshot from the extension, from its data URL to bytes Orbital can
 * store or hand to the model.
 */

export interface ScreenshotBytes {
  mediaType: 'image/png' | 'image/jpeg';
  bytes: Buffer;
}

const DATA_URL_RE = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/;

/** The image a `data:image/png;base64,…` URL carries, or null for anything else. */
export function decodeDataUrl(dataUrl: unknown): ScreenshotBytes | null {
  if (typeof dataUrl !== 'string') return null;
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) return null;
  return { mediaType: match[1] as ScreenshotBytes['mediaType'], bytes };
}

/** Below this many pixels on the longer side a screenshot is not worth sending. */
const MIN_EDGE = 256;

let sharpModule: Promise<typeof import('sharp').default | null> | null = null;

/** Loaded on first use, so a server whose `sharp` cannot load still takes a screenshot that fits. */
function loadSharp(): Promise<typeof import('sharp').default | null> {
  sharpModule ??= import('sharp').then((m) => m.default, () => null);
  return sharpModule;
}

/**
 * The screenshot within `maxBytes` and, when given, `maxEdge` pixels on its
 * longer side: as it came when it already is, else scaled down and, when a
 * PNG is still too big, re-encoded as JPEG. Null when it cannot be made to
 * fit (no `sharp`, or bytes it cannot read).
 */
export async function fitScreenshot(
  shot: ScreenshotBytes,
  opts: { maxBytes: number; maxEdge?: number },
): Promise<ScreenshotBytes | null> {
  const sharp = await loadSharp();
  if (!sharp) return shot.bytes.length <= opts.maxBytes ? shot : null;
  try {
    const meta = await sharp(shot.bytes).metadata();
    const edge = Math.max(meta.width ?? 0, meta.height ?? 0);
    const tooWide = opts.maxEdge !== undefined && edge > opts.maxEdge;
    if (!tooWide && shot.bytes.length <= opts.maxBytes) return shot;
    const target = tooWide ? opts.maxEdge! : edge;
    // A photo-like page compresses badly as PNG; JPEG then, halving the edge
    // until it fits or there is too little left to read.
    const attempts: { edge: number; jpeg?: number }[] = [{ edge: target }, { edge: target, jpeg: 85 }];
    for (let e = Math.round(target / 2); e >= MIN_EDGE; e = Math.round(e / 2)) attempts.push({ edge: e, jpeg: 80 });
    for (const attempt of attempts) {
      const resized = sharp(shot.bytes).resize(attempt.edge, attempt.edge, { fit: 'inside', withoutEnlargement: true });
      const bytes = await (attempt.jpeg === undefined ? resized.png() : resized.jpeg({ quality: attempt.jpeg })).toBuffer();
      if (bytes.length <= opts.maxBytes) return { mediaType: attempt.jpeg === undefined ? 'image/png' : 'image/jpeg', bytes };
    }
    return null;
  } catch {
    return null;
  }
}
