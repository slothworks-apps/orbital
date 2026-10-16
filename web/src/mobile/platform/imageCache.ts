import { fileCache, refKey } from '../files/fileCache'
import { mediaTypeOf } from '../transport/imageResolver'
import { isImageRef } from './parse'

/**
 * Transcript images by ref (spec § 3), kept in the phone's one bounded file
 * cache (spec 2026-10-05-mobile-next § 2) beside the files the viewer has
 * shown. Refs are content hashes, so an entry never goes stale; it leaves
 * only when the cache needs the room, or with the pairing.
 *
 * `ref` is checked against `isImageRef` before it is used at all — the
 * protocol's own `ImageRef` schema (shared/src/remote/messages.ts) only
 * guards `blob_get`/`blob_put`.
 */
/** A thumbnail is kept beside its image, under its own key (spec 2026-10-16-image-sizes-design § 2). */
function keyOf(ref: string, thumb: boolean): string {
  return thumb ? `thumb:${refKey(ref)}` : refKey(ref)
}

export async function readCachedImage(ref: string, thumb = false): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  if (!isImageRef(ref)) return null
  const hit = await fileCache.get(keyOf(ref, thumb))
  return hit ? { bytes: hit.bytes, mediaType: hit.entry.mediaType ?? mediaTypeOf(ref) } : null
}

export async function writeCachedImage(ref: string, bytes: Uint8Array, thumb = false, mediaType = mediaTypeOf(ref)): Promise<void> {
  if (!isImageRef(ref)) throw new Error('not an image ref')
  await fileCache.put(keyOf(ref, thumb), bytes, { w: null, h: null, mediaType })
}

/** The same cache as `clearFileCache`; kept so forgetting the Mac reads as it always did. */
export async function clearImageCache(): Promise<void> {
  await fileCache.clear()
}
