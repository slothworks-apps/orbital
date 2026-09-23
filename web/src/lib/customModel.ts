import { useCallback, useRef, useState } from 'react'
import { api, ApiError } from './api'

export type CustomModelStatus = 'idle' | 'checking' | 'valid' | 'invalid'

export interface CustomModelState {
  text: string
  status: CustomModelStatus
  /** Claude Code's own sentence for an id it cannot start on; null otherwise. */
  reason: string | null
  resolvedModel: string | null
  contextWindow: number | null
}

export interface CustomModelInfo {
  resolvedModel: string | null
  contextWindow: number | null
}

export interface UseCustomModelOptions {
  /** An id that has already run or been validated — starts `valid`, no probe. */
  initial?: { id: string; trusted: true }
  onValidated: (id: string, info: CustomModelInfo) => void
  /** The current text is no longer a validated id (typed over, or rejected). */
  onCleared: () => void
}

/** The server's `{ error }` for a 400, or the raw message for anything else. */
function describeFailure(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.message) as { error?: unknown }
      if (typeof body.error === 'string' && body.error) return body.error
    } catch {
      // Not JSON — fall through to the raw message.
    }
  }
  return err instanceof Error && err.message ? err.message : 'The model id could not be checked.'
}

/**
 * Validation state for the "Other" model field. A probe runs through
 * `api.validateModel` only when the trimmed text is non-empty and differs
 * from the last text probed, so Enter followed by blur costs one call. Any
 * edit returns the status to `idle` and drops a result still in flight — the
 * answer would be about text that is no longer there.
 */
export function useCustomModel({ initial, onValidated, onCleared }: UseCustomModelOptions) {
  const [state, setState] = useState<CustomModelState>(() => ({
    text: initial?.id ?? '',
    status: initial ? 'valid' : 'idle',
    reason: null,
    resolvedModel: null,
    contextWindow: null,
  }))
  const lastProbedRef = useRef<string | null>(initial?.id ?? null)
  /** Bumped by every edit and every probe; a response for an older one is dropped. */
  const seqRef = useRef(0)
  const textRef = useRef(state.text)
  // Callbacks through refs, so `validate` stays stable while the parent
  // passes fresh closures on every render.
  const callbacksRef = useRef({ onValidated, onCleared })
  callbacksRef.current = { onValidated, onCleared }

  const setText = useCallback((text: string) => {
    seqRef.current += 1
    textRef.current = text
    setState({ text, status: 'idle', reason: null, resolvedModel: null, contextWindow: null })
    callbacksRef.current.onCleared()
  }, [])

  const validate = useCallback(async () => {
    const id = textRef.current.trim()
    if (!id || id === lastProbedRef.current) return
    lastProbedRef.current = id
    const seq = ++seqRef.current
    setState((s) => ({ ...s, status: 'checking', reason: null }))
    try {
      const result = await api.validateModel(id)
      if (seq !== seqRef.current) return
      if (result.ok) {
        const info = { resolvedModel: result.resolvedModel, contextWindow: result.contextWindow }
        setState((s) => ({ ...s, status: 'valid', reason: null, ...info }))
        callbacksRef.current.onValidated(id, info)
      } else {
        setState((s) => ({ ...s, status: 'invalid', reason: result.reason }))
        callbacksRef.current.onCleared()
      }
    } catch (err) {
      if (seq !== seqRef.current) return
      // A failed request says nothing about the id, so the same text may be
      // probed again.
      lastProbedRef.current = null
      setState((s) => ({ ...s, status: 'invalid', reason: describeFailure(err) }))
      callbacksRef.current.onCleared()
    }
  }, [])

  return { ...state, setText, validate }
}
