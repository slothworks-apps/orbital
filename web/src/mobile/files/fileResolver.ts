import { TunnelError, type FileResult } from '@orbital/shared/remote/client'
import type { FileAs } from '@orbital/shared/remote/messages'
import { FILE_IDLE_TIMEOUT_MS } from '../constants'
import type { TunnelClient } from '../transport/clientRef'
import { mediaTypeOf } from '../transport/imageResolver'
import { pathKey, refKey, type CacheEntry, type FileCache } from './fileCache'
import { isCantShowStatus } from './route'

/**
 * Reads one file for the viewer (spec 2026-10-05-mobile-next § 2): over
 * `file_get` with its progress, through the phone's cache, and into the one
 * outcome the screen draws (canvas 10e's states, Decision 8's can't-be-shown).
 *
 * A path is read again from the Mac every time it is there — the file may
 * have changed — and the cached copy stands in only while it is not. A ref is
 * its content, so a cached one is never asked for again.
 */
export type FileOutcome =
  /** `cached`: the phone's copy, shown because the Mac is not there; `readAt` is its age. */
  | { kind: 'ready'; bytes: Uint8Array; mediaType: string | null; w: number | null; h: number | null; readAt: number; cached: boolean }
  /** The Mac answered "no such file"; a copy the phone kept still shows, labelled cached. */
  | { kind: 'gone'; copy: Extract<FileOutcome, { kind: 'ready' }> | null }
  /** Outside what the session may show (403). */
  | { kind: 'outside' }
  /** Looked viewable, is not: too large or not what it seemed (413, 415). */
  | { kind: 'cant-show'; size: number | null; mediaType: string | null }
  /** A pause without a byte, or a dropped transfer; `received` is how far it got. */
  | { kind: 'failed'; received: number }
  /** The Mac is not there and the phone has no copy. */
  | { kind: 'waits' }

export interface ResolverDeps {
  client: Pick<TunnelClient, 'getFile' | 'getBlob'>
  cache: Pick<FileCache, 'get' | 'put'>
}

function fromEntry(bytes: Uint8Array, entry: CacheEntry, cached: boolean): Extract<FileOutcome, { kind: 'ready' }> {
  return { kind: 'ready', bytes, mediaType: entry.mediaType, w: entry.w, h: entry.h, readAt: entry.readAt, cached }
}

function isOffline(err: unknown): boolean {
  return err instanceof TunnelError && err.reason === 'offline'
}

export async function readPath(
  deps: ResolverDeps,
  req: {
    sessionId: string
    path: string
    as: FileAs
    /** The `cwd` of the transcript entry the link came from; the Mac reads the path against it. */
    cwd?: string
    onProgress?: (received: number, total: number | null) => void
  },
): Promise<FileOutcome> {
  const key = pathKey(req.sessionId, req.path, req.cwd)
  const cachedCopy = async () => {
    const hit = await deps.cache.get(key).catch(() => null)
    return hit ? fromEntry(hit.bytes, hit.entry, true) : null
  }
  let received = 0
  let answer: FileResult
  try {
    answer = await deps.client.getFile(req.sessionId, req.path, req.as, {
      idleTimeoutMs: FILE_IDLE_TIMEOUT_MS,
      ...(req.cwd ? { cwd: req.cwd } : {}),
      onProgress: (bytes, total) => {
        received = bytes
        req.onProgress?.(bytes, total)
      },
    })
  } catch (err) {
    if (isOffline(err)) return (await cachedCopy()) ?? { kind: 'waits' }
    // A Mac from before PDFs drops a `file_get` it cannot parse without a
    // word, so its refusal of `as: 'pdf'` arrives as silence: the wait runs
    // out before the first byte. Read like any other refusal of a PDF below.
    if (req.as === 'pdf' && received === 0 && err instanceof TunnelError && err.reason === 'timeout') {
      return { kind: 'cant-show', size: null, mediaType: null }
    }
    return { kind: 'failed', received }
  }
  if (answer.status === 200) {
    const meta = { w: answer.w, h: answer.h, mediaType: answer.mediaType }
    // A copy that cannot be written costs the offline view of it, nothing more.
    await deps.cache.put(key, answer.bytes, meta).catch(() => undefined)
    return { kind: 'ready', bytes: answer.bytes, ...meta, readAt: Date.now(), cached: false }
  }
  if (answer.status === 404) return { kind: 'gone', copy: await cachedCopy() }
  if (answer.status === 403) return { kind: 'outside' }
  if (isCantShowStatus(answer.status)) return { kind: 'cant-show', size: answer.size, mediaType: answer.mediaType }
  // A Mac from before PDFs refuses `as: 'pdf'` (spec 2026-10-09-session-media-design
  // § Phone): whatever it answers, the file cannot be shown here.
  if (req.as === 'pdf') return { kind: 'cant-show', size: answer.size, mediaType: answer.mediaType }
  return { kind: 'failed', received }
}

export async function readRef(deps: ResolverDeps, ref: string): Promise<FileOutcome> {
  const key = refKey(ref)
  const hit = await deps.cache.get(key).catch(() => null)
  if (hit) return fromEntry(hit.bytes, hit.entry, false)
  try {
    const answer = await deps.client.getBlob(ref)
    if (answer.status === 404) return { kind: 'gone', copy: null }
    if (answer.status !== 200) return { kind: 'failed', received: 0 }
    const meta = { w: null, h: null, mediaType: mediaTypeOf(ref) }
    await deps.cache.put(key, answer.bytes, meta).catch(() => undefined)
    return { kind: 'ready', bytes: answer.bytes, ...meta, readAt: Date.now(), cached: false }
  } catch (err) {
    return isOffline(err) ? { kind: 'waits' } : { kind: 'failed', received: 0 }
  }
}
