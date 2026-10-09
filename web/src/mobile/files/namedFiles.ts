import type { FileAs } from '@orbital/shared/remote/messages'
import type { FileResolver } from '../../lib/images'
import type { PdfBytesLoader } from '../../lib/pdf'
import { isPdfPath } from '../../lib/pathLinks'
import { IMAGE_URL_CACHE_MAX } from '../constants'
import type { FileOutcome } from './fileResolver'

/**
 * The phone's sources for files a reply names by path (spec
 * 2026-10-09-session-media-design § Phone): `configureImages`' `resolvePath`
 * and `configurePdf`'s `load`, both over `file_get` through the file cache
 * (`readPath`), since the Mac's `/api/files/image` cannot be reached by URL.
 *
 * An image answers with a `blob:` URL, kept like the image store's
 * (`makeImageResolver`): an LRU of at most `max`, one read in flight shared,
 * a failure not remembered so the next ask tries again.
 *
 * A PDF answers at once with an `orbital-pdf:` address naming the file, and
 * the bytes are read only when pdf.js asks the loader for them — a gallery of
 * first pages does not hold every PDF in memory, and `lib/pdf` already keeps
 * what it drew. Any answer but the bytes (a refusal from a Mac that predates
 * PDFs included) is a failure, which the thumbnail draws as not there.
 */

export type ReadNamed = (req: { sessionId: string; path: string; as: FileAs; cwd?: string }) => Promise<FileOutcome>

const PDF_SCHEME = 'orbital-pdf:'

export interface NamedFile {
  sessionId: string
  path: string
  cwd?: string
}

export function pdfAddress(file: NamedFile): string {
  const query = new URLSearchParams({ session: file.sessionId, path: file.path, ...(file.cwd ? { cwd: file.cwd } : {}) })
  return `${PDF_SCHEME}?${query}`
}

/** The file an `orbital-pdf:` address names, or null for any other URL. */
export function parsePdfAddress(url: string): NamedFile | null {
  if (!url.startsWith(PDF_SCHEME)) return null
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1))
  const sessionId = query.get('session')
  const path = query.get('path')
  if (!sessionId || !path) return null
  const cwd = query.get('cwd')
  return { sessionId, path, ...(cwd ? { cwd } : {}) }
}

function blobUrl(bytes: Uint8Array, mediaType: string): string {
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }))
}

/** The bytes of a `ready` outcome; anything else is why there are none. */
function bytesOf(outcome: FileOutcome): Extract<FileOutcome, { kind: 'ready' }> {
  if (outcome.kind !== 'ready') throw new Error(`named file ${outcome.kind}`)
  return outcome
}

export function makeNamedFileResolver(
  read: ReadNamed,
  toUrl: (bytes: Uint8Array, mediaType: string) => string = blobUrl,
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
  max = IMAGE_URL_CACHE_MAX,
): FileResolver {
  const urls = new Map<string, string>()
  const inflight = new Map<string, Promise<string>>()
  const remember = (key: string, url: string) => {
    urls.delete(key)
    urls.set(key, url)
    while (urls.size > max) {
      const [oldest, stale] = urls.entries().next().value as [string, string]
      urls.delete(oldest)
      revoke(stale)
    }
  }
  return (sessionId, path, cwd) => {
    if (isPdfPath(path)) return pdfAddress({ sessionId, path, cwd })
    const key = `${sessionId}\n${cwd ?? ''}\n${path}`
    const known = urls.get(key)
    if (known) {
      remember(key, known)
      return known
    }
    const running = inflight.get(key)
    if (running) return running
    const loading = (async () => {
      const ready = bytesOf(await read({ sessionId, path, as: 'image', ...(cwd ? { cwd } : {}) }))
      const url = toUrl(ready.bytes, ready.mediaType ?? 'application/octet-stream')
      remember(key, url)
      return url
    })()
    inflight.set(key, loading)
    void loading.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    )
    return loading
  }
}

/**
 * `configurePdf`'s loader: an `orbital-pdf:` address is read over the tunnel
 * as `pdf`; anything else — the `blob:` URL the viewer makes of bytes it
 * already holds — is fetched as usual.
 */
export function makePdfLoader(
  read: ReadNamed,
  fetchBytes: PdfBytesLoader = async (url) => (await fetch(url)).arrayBuffer(),
): PdfBytesLoader {
  return async (url) => {
    const file = parsePdfAddress(url)
    if (!file) return fetchBytes(url)
    const { bytes } = bytesOf(await read({ ...file, as: 'pdf' }))
    return bytes.slice().buffer
  }
}
