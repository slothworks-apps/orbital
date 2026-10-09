import { useEffect, useState } from 'react'
import type { FileAs } from '@orbital/shared/remote/messages'
import { useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { fileCache, pathKey } from './fileCache'
import { readPath, readRef, type FileOutcome } from './fileResolver'

/** One file the file screen shows: a path the transcript named, or an image known by its ref. */
export type FileSource =
  /** `cwd`: the one the transcript entry naming the path was written in, when there was one. */
  | { kind: 'path'; sessionId: string; path: string; as: FileAs; cwd?: string }
  | { kind: 'ref'; ref: string; w: number | null; h: number | null }

export type FileView =
  /** Bytes on their way: how many, of how many when the Mac said. */
  | { phase: 'loading'; received: number; total: number | null }
  | { phase: 'done'; outcome: FileOutcome }

function sourceKey(source: FileSource): string {
  return source.kind === 'ref' ? `ref:${source.ref}` : `${source.as}:${pathKey(source.sessionId, source.path, source.cwd)}`
}

/**
 * Reads `source` for the screen, with the byte count as it arrives (spec
 * 2026-10-05-mobile-next § 2, Loading). `retry` asks again from the start.
 * While the Mac is away and the phone has no copy, it reads again on its own
 * the moment the tunnel is back (10e MAC ASLEEP · NOT CACHED: "Stay here and
 * it loads on its own").
 */
export function useFile(source: FileSource): { view: FileView; retry: () => void; known: { w: number; h: number } | null } {
  const key = sourceKey(source)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key: string; attempt: number; view: FileView }>({
    key, attempt, view: { phase: 'loading', received: 0, total: null },
  })
  const [known, setKnown] = useState<{ key: string; w: number; h: number } | null>(null)
  const ready = useMobile((s) => s.ready)

  useEffect(() => {
    let live = true
    const deps = { client: clientRef, cache: fileCache }
    // What the phone last knew of the file's size, for the reserved box (10e).
    if (source.kind === 'path') {
      void fileCache.peek(pathKey(source.sessionId, source.path, source.cwd)).then((entry) => {
        if (live && entry?.w && entry.h) setKnown({ key, w: entry.w, h: entry.h })
      })
    }
    const run =
      source.kind === 'ref'
        ? readRef(deps, source.ref)
        : readPath(deps, {
            sessionId: source.sessionId,
            path: source.path,
            as: source.as,
            cwd: source.cwd,
            onProgress: (received, total) => {
              if (live) setState({ key, attempt, view: { phase: 'loading', received, total } })
            },
          })
    void run.then((outcome) => {
      if (live) setState({ key, attempt, view: { phase: 'done', outcome } })
    })
    return () => {
      live = false
    }
    // `source` is fully described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])

  const current = state.key === key && state.attempt === attempt ? state.view : { phase: 'loading' as const, received: 0, total: null }
  const waiting = current.phase === 'done' && current.outcome.kind === 'waits'
  useEffect(() => {
    if (waiting && ready) setAttempt((a) => a + 1)
  }, [waiting, ready])

  const refDims = source.kind === 'ref' && source.w && source.h ? { w: source.w, h: source.h } : null
  const doneDims =
    current.phase === 'done' && current.outcome.kind === 'ready' && current.outcome.w && current.outcome.h
      ? { w: current.outcome.w, h: current.outcome.h }
      : null
  const knownDims = known && known.key === key ? { w: known.w, h: known.h } : null
  return { view: current, retry: () => setAttempt((a) => a + 1), known: doneDims ?? refDims ?? knownDims }
}
