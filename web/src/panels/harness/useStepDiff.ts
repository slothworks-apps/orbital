import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { StepState } from '../../lib/types'
import { parsePatch, type ParsedPatch } from './patch'

export interface StepDiff {
  range: string
  stat: string
  parsed: ParsedPatch
  /** Null when the repository could not say. */
  commits: number | null
  pushed: boolean | null
}

/** The server's `{ error }` sentence out of a failed request, which carries the raw body. */
function reasonOf(err: unknown): string {
  if (!(err instanceof Error)) return 'Failed to load the diff'
  try {
    const body = JSON.parse(err.message) as { error?: unknown }
    if (typeof body.error === 'string') return body.error
  } catch {
    // Not JSON: the message is the reason as it is.
  }
  return err.message
}

/** A range's diff never changes, so one fetch per range is enough for the page's life. */
const cache = new Map<string, Promise<StepDiff>>()

/**
 * The step's commit range as a parsed diff (the step-diff route), or null
 * while it loads or when the step has no range. `error` says why it failed.
 */
export function useStepDiff(sessionId: string, index: number, state: StepState | undefined): { diff: StepDiff | null; error: string | null } {
  const key = state?.startHead && state.endHead ? `${sessionId}:${index}:${state.startHead}..${state.endHead}` : null
  const [result, setResult] = useState<{ key: string; diff: StepDiff | null; error: string | null } | null>(null)

  useEffect(() => {
    if (!key) return
    let live = true
    let pending = cache.get(key)
    if (!pending) {
      pending = api.getHarnessStepDiff(sessionId, index).then((d) => ({ range: d.range, stat: d.stat, parsed: parsePatch(d.patch), commits: d.commits, pushed: d.pushed }))
      cache.set(key, pending)
      pending.catch(() => cache.delete(key))
    }
    pending.then(
      (diff) => live && setResult({ key, diff, error: null }),
      (err: unknown) => live && setResult({ key, diff: null, error: reasonOf(err) }),
    )
    return () => {
      live = false
    }
  }, [key, sessionId, index])

  if (!key || result?.key !== key) return { diff: null, error: null }
  return { diff: result.diff, error: result.error }
}
