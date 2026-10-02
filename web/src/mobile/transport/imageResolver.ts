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
 */
export function makeImageResolver(
  client: Pick<TunnelClient, 'getBlob'>,
  io: ImageStoreIO,
  toUrl: (bytes: Uint8Array, mediaType: string) => string = blobUrl,
): (ref: string) => string | Promise<string> {
  const urls = new Map<string, string>()
  const inflight = new Map<string, Promise<string>>()
  return (ref) => {
    const known = urls.get(ref)
    if (known) return known
    const running = inflight.get(ref)
    if (running) return running
    const loading = (async () => {
      let bytes = await io.read(ref)
      if (!bytes) {
        const answer = await client.getBlob(ref)
        if (answer.status !== 200) throw new Error(`image ${answer.status}`)
        bytes = answer.bytes
        // A cache write that fails costs a refetch next time, nothing more.
        await io.write(ref, bytes).catch(() => undefined)
      }
      const url = toUrl(bytes, mediaTypeOf(ref))
      urls.set(ref, url)
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
