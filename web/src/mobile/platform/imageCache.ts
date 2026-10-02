import { Directory, Filesystem } from '@capacitor/filesystem'
import { base64ToBytes, bytesToBase64 } from './base64'

/**
 * Transcript images by ref (spec § 3). Refs are content hashes, so an entry
 * never goes stale and nothing here expires; "Pair a different Mac" and an
 * unpairing clear it, and the OS may evict the Cache directory on its own.
 */
const IMAGES_DIR = 'images'

export async function readCachedImage(ref: string): Promise<Uint8Array | null> {
  try {
    const { data } = await Filesystem.readFile({ path: `${IMAGES_DIR}/${ref}`, directory: Directory.Cache })
    return typeof data === 'string' ? base64ToBytes(data) : new Uint8Array(await data.arrayBuffer())
  } catch {
    return null
  }
}

export async function writeCachedImage(ref: string, bytes: Uint8Array): Promise<void> {
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
