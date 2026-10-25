import { useEffect, useState } from 'react'

/**
 * A text field's draft of a stored value, and the stored value it was last
 * in step with (`base`). The draft differs from `base` while the user has an
 * edit not yet saved.
 */
export interface SyncedDraft {
  draft: string
  base: string
}

/**
 * Where a draft goes when the stored value becomes `value` — a value another
 * member of the group set, or this field's own save landing. A draft with no
 * unsaved edit follows it; so does a draft that already says what was
 * stored. An unsaved edit is kept, so the user's next save is a deliberate
 * change made after the one that arrived.
 */
export function followStored(state: SyncedDraft, value: string): SyncedDraft {
  if (value === state.base) return state
  if (state.draft === state.base || state.draft === value) return { draft: value, base: value }
  return state
}

/**
 * The draft of a shared setting's text field (spec
 * 2026-10-24-group-shared-settings-design): seeded from `value` when `open`
 * turns true, and following `value` while it changes from outside, as
 * `followStored` says.
 */
export function useSyncedDraft(value: string, open: boolean): [string, (draft: string) => void] {
  const [state, setState] = useState<SyncedDraft>({ draft: value, base: value })

  useEffect(() => {
    if (open) setState({ draft: value, base: value })
    // Reseeded on open only; while open, the effect below follows `value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    setState((current) => followStored(current, value))
  }, [value])

  return [state.draft, (draft) => setState((current) => ({ ...current, draft }))]
}
