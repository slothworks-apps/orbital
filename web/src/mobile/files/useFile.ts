import { useEffect, useMemo, useState } from 'react'
import type { FileAs } from '@orbital/shared/remote/messages'
import { useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { fileCache, pathKey, refKey } from './fileCache'
import { readCopy, readPath, readRef, revalidated, type FileOutcome, type ReadyOutcome } from './fileResolver'
import { recentFile, rememberFile } from './recentFiles'

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

function cacheKey(source: FileSource): string {
  return source.kind === 'ref' ? refKey(source.ref) : pathKey(source.sessionId, source.path, source.cwd)
}

const LOADING: FileView = { phase: 'loading', received: 0, total: null }

/**
 * Reads `source` for the screen, with the byte count as it arrives (spec
 * 2026-10-05-mobile-next § 2, Loading). `retry` asks again from the start.
 * While the Mac is away and the phone has no copy, it reads again on its own
 * the moment the tunnel is back (10e MAC ASLEEP · NOT CACHED: "Stay here and
 * it loads on its own").
 *
 * A file the phone already has shows at once: one of the last few shown
 * from memory on the first paint (`recentFiles.ts`), else the copy on disk.
 * A ref is then done; a path is still asked of the Mac behind it and swapped
 * only when the Mac's answer differs (`revalidated`). `instant` says the
 * bytes came from the phone, with nothing to wait for or fade in.
 */
export function useFile(source: FileSource): {
  view: FileView
  retry: () => void
  known: { w: number; h: number } | null
  instant: boolean
} {
  const key = sourceKey(source)
  const [attempt, setAttempt] = useState(0)
  // A retry reads afresh, past what the phone remembers.
  const remembered = useMemo(() => (attempt === 0 ? recentFile(key) : null), [key, attempt])
  const [state, setState] = useState<{ key: string; attempt: number; view: FileView; instant: boolean }>({
    key, attempt, view: LOADING, instant: false,
  })
  const [known, setKnown] = useState<{ key: string; w: number; h: number } | null>(null)
  const ready = useMobile((s) => s.ready)

  useEffect(() => {
    let live = true
    let settled = false
    let shown: ReadyOutcome | null = remembered
    const deps = { client: clientRef, cache: fileCache }
    const show = (view: FileView) => {
      if (live) setState({ key, attempt, view, instant: shown !== null })
    }
    const settle = (outcome: FileOutcome) => {
      settled = true
      const next = shown ? revalidated(shown, outcome) : outcome
      if (next.kind === 'ready') rememberFile(key, next)
      show({ phase: 'done', outcome: next })
    }
    const showCopy = (copy: ReadyOutcome | null) => {
      if (!copy || settled || shown) return false
      shown = copy
      rememberFile(key, copy)
      show({ phase: 'done', outcome: copy })
      return true
    }

    if (source.kind === 'ref') {
      // A ref is its content: the phone's copy is the answer.
      if (!shown) {
        void readCopy(deps, cacheKey(source)).then((copy) => {
          if (live && !showCopy(copy)) void readRef(deps, source.ref).then((o) => live && settle(o))
        })
      }
    } else {
      // What the phone last knew of the file's size, for the reserved box (10e).
      void fileCache.peek(cacheKey(source)).then((entry) => {
        if (live && entry?.w && entry.h) setKnown({ key, w: entry.w, h: entry.h })
      })
      if (!shown) void readCopy(deps, cacheKey(source)).then((copy) => live && showCopy(copy))
      void readPath(deps, {
        sessionId: source.sessionId,
        path: source.path,
        as: source.as,
        cwd: source.cwd,
        // A copy on screen stays there while the Mac answers; no loading over it.
        onProgress: (received, total) => {
          if (!shown) show({ phase: 'loading', received, total })
        },
      }).then((o) => live && settle(o))
    }
    return () => {
      live = false
    }
    // `source` is fully described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])

  const mine = state.key === key && state.attempt === attempt
  const current = mine ? state.view : remembered ? { phase: 'done' as const, outcome: remembered } : LOADING
  const instant = mine ? state.instant : remembered !== null
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
  return { view: current, retry: () => setAttempt((a) => a + 1), known: doneDims ?? refDims ?? knownDims, instant }
}
