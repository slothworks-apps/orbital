import { useEffect } from 'react'
import { create } from 'zustand'
import type { SlotKeyProps, SlotProps } from '../session/slot'

type Outcome = { sessionId: string; kind: 'ended' | 'cleared' }

/**
 * What the ⋯ sheet's End or Clear just did, for the session it left on
 * screen: the ended one, or the fresh one Clear opened in its place. Outside
 * the sheet, because Clear swaps the session screen (and the sheet with it)
 * for the new session's.
 */
export const useMenuOutcome = create<{ outcome: Outcome | null }>()(() => ({ outcome: null }))

export function noteOutcome(outcome: Outcome): void {
  useMenuOutcome.setState({ outcome })
}

/** Canvas 10i's copy for the line under the transcript. */
const LINE: Record<Outcome['kind'], string> = {
  ended: 'Ended · moved to Ended in the list',
  cleared: 'Cleared · a fresh session started here',
}

/**
 * The ✓ line at the end of the transcript after End or Clear (canvas 10i).
 * It belongs to the session it names and is forgotten when that session's
 * screen closes.
 */
export function MenuOutcome({ session }: SlotProps) {
  const outcome = useMenuOutcome((s) => (s.outcome?.sessionId === session.id ? s.outcome : null))
  const id = session.id
  useEffect(
    () => () => {
      if (useMenuOutcome.getState().outcome?.sessionId === id) useMenuOutcome.setState({ outcome: null })
    },
    [id],
  )
  if (!outcome) return null
  // canvas 10i: the cyan-tinted confirmation row.
  return (
    <div
      role="status"
      className="my-3 flex min-h-12 items-center gap-2.5 rounded-[12px] border border-[oklch(85%_.12_205/.35)] bg-[oklch(85%_.12_205/.1)] px-3 text-[13.5px]"
    >
      <span aria-hidden className="text-[oklch(85%_.12_205)]">✓</span>
      <span className="flex-1">{LINE[outcome.kind]}</span>
    </div>
  )
}

/** The tail's key piece: the line appearing keeps a reader at the bottom. */
export function useMenuOutcomeKey({ session }: SlotKeyProps): string | null {
  return useMenuOutcome((s) => (session && s.outcome?.sessionId === session.id ? s.outcome.kind : null))
}
