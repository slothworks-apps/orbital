import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Where a transcript image's bytes come from (spec 2026-10-02-mobile-app-design
 * § 3). The web answers with the API path, synchronously; the phone answers
 * with a blob URL from its file cache, fetched over the tunnel when missing,
 * and memoizes per ref so asking twice never fetches twice.
 */
export type ImageResolver = (ref: string) => string | Promise<string>

/**
 * Where the bytes of a file a session's text names come from — an image or a
 * PDF on disk (spec 2026-10-09-session-media-design § Bytes of named files).
 * The web answers with `/api/files/image`; a platform that cannot reach that
 * route by URL configures its own, or none.
 */
export type FileResolver = (sessionId: string, path: string, cwd?: string) => string | Promise<string>

export const apiImagePath = (ref: string): string => `/api/images/${ref}`

/** An image on disk that a session's text names by path, read inside that
 * session's trees — inside `cwd` when the path came from a transcript entry
 * that recorded one (spec 2026-10-07-live-working-tree-design § 4). The
 * `:line` suffix never travels, as with the file viewer. */
export const apiFileImagePath = (sessionId: string, path: string, cwd?: string): string =>
  `/api/files/image?${new URLSearchParams({ session: sessionId, path, ...(cwd ? { cwd } : {}) })}`

let resolver: ImageResolver = apiImagePath
let fileResolver: FileResolver | null = apiFileImagePath

/**
 * Configured by a platform whose bytes do not come from this origin (the
 * phone). `resolvePath` is the named files' half: left out, named files have
 * no source at all, and what draws them by URL — the reply thumbnails — stays
 * away rather than drawing broken images.
 */
export function configureImages(opts: { resolve: ImageResolver; resolvePath?: FileResolver | null }): void {
  resolver = opts.resolve
  fileResolver = opts.resolvePath ?? null
}

export function resolveImage(ref: string): string | Promise<string> {
  return resolver(ref)
}

/** Whether named files can be shown here at all — see `configureImages`. */
export function canResolveFiles(): boolean {
  return fileResolver !== null
}

export function resolveFile(sessionId: string, path: string, cwd?: string): string | Promise<string> {
  if (!fileResolver) return Promise.reject(new Error('no file resolver configured'))
  return fileResolver(sessionId, path, cwd)
}

export interface ImageUrl {
  /** Null while an async resolver is still out, and after it failed. */
  url: string | null
  failed: boolean
  /** The URL came through a promise — worth fading in, where a synchronous one is already there. */
  async: boolean
  retry: () => void
}

type Settled = { key: string; url: string | null; failed: boolean }

/**
 * A URL from a resolver that may answer at once or later. `key` names what is
 * being resolved; a new key, or a retry, asks `resolve` again.
 */
function useResolvedUrl(key: string, resolve: () => string | Promise<string>): ImageUrl {
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<Settled>({ key: '', url: null, failed: false })
  const attemptKey = `${key}#${attempt}`
  // Read during render so a synchronous answer (the web's path, a phone's
  // cached blob URL) is on the first paint and nothing flickers.
  const answer = useMemo(() => {
    const result = resolve()
    if (typeof result === 'string') return { url: result, pending: null }
    // Handled here at once; the effect below reads the same promise.
    void result.catch(() => undefined)
    return { url: null, pending: result }
    // `key` stands for `resolve`, whose identity changes every render;
    // `attempt` is the retry: a new attempt asks the resolver again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])

  useEffect(() => {
    if (!answer.pending) return
    let live = true
    void answer.pending.then(
      (url) => {
        if (live) setSettled({ key: attemptKey, url, failed: false })
      },
      () => {
        if (live) setSettled({ key: attemptKey, url: null, failed: true })
      },
    )
    return () => {
      live = false
    }
  }, [answer, attemptKey])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  if (answer.url !== null) return { url: answer.url, failed: false, async: false, retry }
  const mine = settled.key === attemptKey
  return { url: mine ? settled.url : null, failed: mine && settled.failed, async: true, retry }
}

export function useImageUrl(ref: string): ImageUrl {
  return useResolvedUrl(ref, () => resolveImage(ref))
}

/** Where a media item's bytes live: the image store, or a file a reply named. */
export interface MediaSource {
  ref?: string
  path?: string
  cwd?: string
}

/** The URL of a media item's bytes, whichever of the two places they live in. */
export function useMediaSourceUrl(sessionId: string, source: MediaSource): ImageUrl {
  const { ref, path, cwd } = source
  const key = ref !== undefined ? `ref\n${ref}` : `file\n${sessionId}\n${cwd ?? ''}\n${path ?? ''}`
  return useResolvedUrl(key, () => (ref !== undefined ? resolveImage(ref) : resolveFile(sessionId, path ?? '', cwd)))
}
