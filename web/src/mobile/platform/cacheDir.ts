import { Directory, Filesystem } from '@capacitor/filesystem'
import type { CacheIO } from '../files/fileCache'
import { base64ToBytes, bytesToBase64 } from './base64'

/**
 * Where the phone's file cache lives on disk (spec 2026-10-05-mobile-next
 * § 2): the app's Cache directory, which the OS may also empty on its own —
 * a missing file reads as a miss, never as an error.
 *
 * Entry names are the cache's own counters, never a path or a ref, so
 * nothing a transcript wrote is ever interpolated into a filesystem path.
 */
const FILES_DIR = 'files'
const INDEX = `${FILES_DIR}/index.json`
/** The unbounded ref cache this one replaced; removed with everything else. */
const LEGACY_IMAGES_DIR = 'images'

async function readBytes(path: string): Promise<Uint8Array | null> {
  try {
    const { data } = await Filesystem.readFile({ path, directory: Directory.Cache })
    return typeof data === 'string' ? base64ToBytes(data) : new Uint8Array(await data.arrayBuffer())
  } catch {
    return null
  }
}

async function removeDir(path: string): Promise<void> {
  try {
    await Filesystem.rmdir({ path, directory: Directory.Cache, recursive: true })
  } catch {
    // Nothing there yet.
  }
}

export const cacheDirIO: CacheIO = {
  async readIndex() {
    const bytes = await readBytes(INDEX)
    return bytes ? new TextDecoder().decode(bytes) : null
  },
  async writeIndex(json) {
    await Filesystem.writeFile({
      path: INDEX, data: bytesToBase64(new TextEncoder().encode(json)), directory: Directory.Cache, recursive: true,
    })
  },
  read: (name) => readBytes(`${FILES_DIR}/${name}`),
  async write(name, bytes) {
    await Filesystem.writeFile({
      path: `${FILES_DIR}/${name}`, data: bytesToBase64(bytes), directory: Directory.Cache, recursive: true,
    })
  },
  async remove(name) {
    try {
      await Filesystem.deleteFile({ path: `${FILES_DIR}/${name}`, directory: Directory.Cache })
    } catch {
      // Already gone — the OS may have cleared it.
    }
  },
  async wipe() {
    await Promise.all([removeDir(FILES_DIR), removeDir(LEGACY_IMAGES_DIR)])
  },
}
