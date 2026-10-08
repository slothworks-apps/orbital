import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Where a transcript image's bytes come from (spec 2026-10-02-mobile-app-design
 * § 3). The web answers with the API path, synchronously; the phone answers
 * with a blob URL from its file cache, fetched over the tunnel when missing,
 * and memoizes per ref so asking twice never fetches twice.
 */
export type ImageResolver = (ref: string) => string | Promise<string>

export const apiImagePath = (ref: string): string => `/api/images/${ref}`

/** An image on disk that a session's text names by path, read inside that
 * session's trees — inside `cwd` when the path came from a transcript entry
 * that recorded one (spec 2026-10-07-live-working-tree-design § 4). The
 * `:line` suffix never travels, as with the file viewer. */
export const apiFileImagePath = (sessionId: string, path: string, cwd?: string): string =>
  `/api/files/image?${new URLSearchParams({ session: sessionId, path, ...(cwd ? { cwd } : {}) })}`

let resolver: ImageResolver = apiImagePath

export function configureImages(opts: { resolve: ImageResolver }): void {
  resolver = opts.resolve
}

export function resolveImage(ref: string): string | Promise<string> {
  return resolver(ref)
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

export function useImageUrl(ref: string): ImageUrl {
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<Settled>({ key: '', url: null, failed: false })
  const key = `${ref}#${attempt}`
  // Read during render so a synchronous answer (the web's path, a phone's
  // cached blob URL) is on the first paint and nothing flickers.
  const answer = useMemo(() => {
    const result = resolveImage(ref)
    if (typeof result === 'string') return { url: result, pending: null }
    // Handled here at once; the effect below reads the same promise.
    void result.catch(() => undefined)
    return { url: null, pending: result }
    // `attempt` is the retry: a new attempt asks the resolver again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, attempt])

  useEffect(() => {
    if (!answer.pending) return
    let live = true
    void answer.pending.then(
      (url) => {
        if (live) setSettled({ key, url, failed: false })
      },
      () => {
        if (live) setSettled({ key, url: null, failed: true })
      },
    )
    return () => {
      live = false
    }
  }, [answer, key])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  if (answer.url !== null) return { url: answer.url, failed: false, async: false, retry }
  const mine = settled.key === key
  return { url: mine ? settled.url : null, failed: mine && settled.failed, async: true, retry }
}
