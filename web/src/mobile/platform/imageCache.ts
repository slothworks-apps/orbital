import { Directory, Filesystem } from '@capacitor/filesystem'
import { base64ToBytes, bytesToBase64 } from './base64'
import { isImageRef } from './parse'

/**
 * Transcript images by ref (spec § 3). Refs are content hashes, so an entry
 * never goes stale and nothing here expires; "Pair a different Mac" and an
 * unpairing clear it, and the OS may evict the Cache directory on its own.
 *
 * `ref` is interpolated straight into the filesystem path, so it is checked
 * against `isImageRef` before it ever reaches the plugin — the protocol's
 * own `ImageRef` schema (shared/src/remote/messages.ts) only guards the one
 * caller that is `blob_get`/`blob_put`, not a path built here directly.
 */
const IMAGES_DIR = 'images'

export async function readCachedImage(ref: string): Promise<Uint8Array | null> {
  if (!isImageRef(ref)) return null
  try {
    const { data } = await Filesystem.readFile({ path: `${IMAGES_DIR}/${ref}`, directory: Directory.Cache })
    return typeof data === 'string' ? base64ToBytes(data) : new Uint8Array(await data.arrayBuffer())
  } catch {
    return null
  }
}

export async function writeCachedImage(ref: string, bytes: Uint8Array): Promise<void> {
  if (!isImageRef(ref)) throw new Error('not an image ref')
  await Filesystem.writeFile({
    path: `${IMAGES_DIR}/${ref}`,
    data: bytesToBase64(bytes),
    directory: Directory.Cache,
    recursive: true,
  })
}

export async function clearImageCache(): Promise<void> {
  try {
    await Filesystem.rmdir({ path: IMAGES_DIR, directory: Directory.Cache, recursive: true })
  } catch {
    // Nothing cached yet.
  }
}
