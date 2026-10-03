import { IMAGE_URL_CACHE_MAX } from '../constants'
import type { TunnelClient } from './clientRef'

export interface ImageStoreIO {
  read(ref: string): Promise<Uint8Array | null>
  write(ref: string, bytes: Uint8Array): Promise<void>
}

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
}

/** The ref's extension is what names its type, as on the Mac (`server/src/images/store.ts`). */
export function mediaTypeOf(ref: string): string {
  return MEDIA_TYPES[ref.slice(ref.lastIndexOf('.') + 1)] ?? 'application/octet-stream'
}

function blobUrl(bytes: Uint8Array, mediaType: string): string {
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }))
}

/**
 * The phone's `configureImages` resolver (spec § 3): the file cache first,
 * the tunnel when it misses. A ref resolved once answers synchronously from
 * then on, and one in flight is shared, so a thumbnail and its lightbox
 * never fetch twice. A failure is not remembered: the next ask (9p's retry)
 * tries again.
 *
 * The URLs are an LRU of at most `max` (spec § 6.2): an ask moves its ref to
 * the newest place, and storing one past the bound revokes and drops the
 * oldest. Revoking a URL an `<img>` still shows would blank it, which is why
 * `IMAGE_URL_CACHE_MAX` sits well above one screen of images. An evicted ref
 * asked again reads the file cache, not the tunnel.
 */
export function makeImageResolver(
  client: Pick<TunnelClient, 'getBlob'>,
  io: ImageStoreIO,
  toUrl: (bytes: Uint8Array, mediaType: string) => string = blobUrl,
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
  max = IMAGE_URL_CACHE_MAX,
): (ref: string) => string | Promise<string> {
  // A Map iterates in insertion order, so re-inserting on a hit keeps the oldest first.
  const urls = new Map<string, string>()
  const inflight = new Map<string, Promise<string>>()
  const remember = (ref: string, url: string) => {
    urls.delete(ref)
    urls.set(ref, url)
    while (urls.size > max) {
      const [oldest, stale] = urls.entries().next().value as [string, string]
      urls.delete(oldest)
      revoke(stale)
    }
  }
  return (ref) => {
    const known = urls.get(ref)
    if (known) {
      remember(ref, known)
      return known
    }
    const running = inflight.get(ref)
    if (running) return running
    const loading = (async () => {
      // A cache read that fails is a miss, not a reason to give up: fall through to the tunnel.
      let bytes = await io.read(ref).catch(() => null)
      if (!bytes) {
        const answer = await client.getBlob(ref)
        if (answer.status !== 200) throw new Error(`image ${answer.status}`)
        bytes = answer.bytes
        // A cache write that fails costs a refetch next time, nothing more.
        await io.write(ref, bytes).catch(() => undefined)
      }
      const url = toUrl(bytes, mediaTypeOf(ref))
      remember(ref, url)
      return url
    })()
    inflight.set(ref, loading)
    void loading.then(
      () => inflight.delete(ref),
      () => inflight.delete(ref),
    )
    return loading
  }
}
