import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorSentence } from './api'

export type CustomModelStatus = 'idle' | 'checking' | 'valid' | 'invalid'

export interface CustomModelState {
  text: string
  status: CustomModelStatus
  /** Claude Code's own sentence for an id it cannot start on, or why the check could not run; null otherwise. */
  reason: string | null
  /** `invalid` because the check could not run at all (a failed request), not because the id was refused. */
  checkFailed: boolean
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
  /**
   * The Claude directory the session would run under — the id is checked under
   * its account. Absent, the server's default directory. Read at probe time.
   */
  claudeDir?: number
  /** The device of the group the session would run on (the phone's New session); absent, this one. */
  machine?: string
  /** The words for a check that could not run at all; the server's own sentence by default. */
  describeFailure?: (err: unknown) => string
}

const defaultFailure = (err: unknown): string => errorSentence(err, 'The model id could not be checked.')

/** The account an id is checked under: a validation holds for it alone. */
const scopeOf = (claudeDir: number | undefined, machine: string | undefined) => `${machine ?? ''}|${claudeDir ?? ''}`

const blank = { reason: null, checkFailed: false, resolvedModel: null, contextWindow: null }

/**
 * Validation state for the "Other" model field. A probe runs through
 * `api.validateModel` only when the trimmed text is non-empty and differs
 * from the last text probed, so Enter followed by blur costs one call. Any
 * edit returns the status to `idle` and drops a result still in flight — the
 * answer would be about text that is no longer there. So do `cancel`, an
 * unmount, and a change of the account the id is checked under: a validation
 * holds only for the account it ran under, so `valid` reads as `idle` once
 * `claudeDir` or `machine` changes.
 */
export function useCustomModel({ initial, onValidated, onCleared, claudeDir, machine, describeFailure }: UseCustomModelOptions) {
  const scope = scopeOf(claudeDir, machine)
  const [state, setState] = useState<CustomModelState & { scope: string }>(() => ({
    text: initial?.id ?? '',
    status: initial ? 'valid' : 'idle',
    ...blank,
    scope,
  }))
  /** The last `scope` + text probed; the same text under another account is probed again. */
  const lastProbedRef = useRef<string | null>(initial ? `${scope}\n${initial.id}` : null)
  /** Bumped by every edit, every probe and every cancel; a response for an older one is dropped. */
  const seqRef = useRef(0)
  const textRef = useRef(state.text)
  // Callbacks through refs, so `validate` stays stable while the parent
  // passes fresh closures on every render.
  const callbacksRef = useRef({ onValidated, onCleared, claudeDir, machine, describeFailure })
  callbacksRef.current = { onValidated, onCleared, claudeDir, machine, describeFailure }

  // A check still out when the field goes away must not land on a selection
  // made since — a card picked, the list or the sheet closed.
  useEffect(
    () => () => {
      seqRef.current += 1
    },
    [],
  )

  const setText = useCallback((text: string) => {
    seqRef.current += 1
    textRef.current = text
    setState((s) => ({ text, status: 'idle', ...blank, scope: s.scope }))
    callbacksRef.current.onCleared()
  }, [])

  /** Puts `text` in the field without a probe — `trusted`, an id already validated or run under this account. */
  const seed = useCallback((text: string, trusted: boolean) => {
    seqRef.current += 1
    textRef.current = text
    const { claudeDir: dir, machine: device } = callbacksRef.current
    const at = scopeOf(dir, device)
    lastProbedRef.current = trusted ? `${at}\n${text.trim()}` : null
    setState({ text, status: trusted ? 'valid' : 'idle', ...blank, scope: at })
  }, [])

  /** Drops a check under way; the text stays, to be checked again. */
  const cancel = useCallback(() => {
    seqRef.current += 1
    setState((s) => {
      if (s.status !== 'checking') return s
      lastProbedRef.current = null
      return { ...s, status: 'idle' }
    })
  }, [])

  const validate = useCallback(async () => {
    const id = textRef.current.trim()
    const { claudeDir: dir, machine: device } = callbacksRef.current
    const at = scopeOf(dir, device)
    if (!id || `${at}\n${id}` === lastProbedRef.current) return
    lastProbedRef.current = `${at}\n${id}`
    const seq = ++seqRef.current
    setState((s) => ({ ...s, status: 'checking', reason: null, checkFailed: false, scope: at }))
    // Arguments only as far as they are set: the phone's federation routes by `machine`.
    const probe =
      device !== undefined
        ? api.validateModel(id, dir, device)
        : dir === undefined
          ? api.validateModel(id)
          : api.validateModel(id, dir)
    try {
      const result = await probe
      if (seq !== seqRef.current) return
      const now = callbacksRef.current
      if (scopeOf(now.claudeDir, now.machine) !== at) {
        // The account changed while the check was out: its answer is about the old one.
        lastProbedRef.current = null
        setState((s) => ({ ...s, status: 'idle' }))
        return
      }
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
      const describe = callbacksRef.current.describeFailure ?? defaultFailure
      setState((s) => ({ ...s, status: 'invalid', reason: describe(err), checkFailed: true }))
      callbacksRef.current.onCleared()
    }
  }, [])

  // A result under another account than the one now chosen says nothing about it.
  const { scope: checkedUnder, ...shown } = state
  const stale = checkedUnder !== scope && shown.status !== 'idle'
  return {
    ...(stale ? { ...shown, status: 'idle' as const, ...blank } : shown),
    setText,
    seed,
    cancel,
    validate,
  }
}

export type CustomModelField = ReturnType<typeof useCustomModel>
