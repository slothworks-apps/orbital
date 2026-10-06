import { create } from 'zustand'
import { nameInSentence } from '../format'
import { ConfirmSheet } from '../ui'

/**
 * The tasks this phone stopped in this run, keyed `<sessionId>:<taskId>`.
 * The Mac records only that a task was stopped, not by whom, so "stopped by
 * you" is said only for a stop sent from here (spec 2026-10-05-mobile-next
 * Decision 3); a relaunch forgets, and the task reads plain STOPPED.
 */
export const useStoppedHere = create<{ keys: Record<string, true>; mark(key: string): void }>()((set) => ({
  keys: {},
  mark: (key) => set((s) => ({ keys: { ...s.keys, [key]: true } })),
}))

export const stoppedHereKey = (sessionId: string, taskId: string): string => `${sessionId}:${taskId}`

/**
 * STOP TASK (canvas 10g, the sheet over the output): a stop asks once, since
 * on a phone a stray thumb is likelier than on the desktop, which stops in
 * one click. The process stops; its output stays, and the session goes on.
 */
export function StopTaskSheet({
  label,
  ranFor,
  parentTitle,
  onStop,
  onCancel,
}: {
  label: string
  /** "3h 04m"; undefined when the task's start is unknown. */
  ranFor: string | undefined
  parentTitle: string
  onStop: () => void
  onCancel: () => void
}) {
  return (
    <ConfirmSheet
      eyebrow="STOP TASK"
      title={`Stop ${label}?`}
      body={`${ranFor ? `It has run for ${ranFor}. ` : ''}The process stops, its output stays readable here, and ${nameInSentence(parentTitle)} is told it was stopped. The session itself keeps going.`}
      confirmLabel="Stop task"
      cancelLabel="Keep running"
      onConfirm={onStop}
      onCancel={onCancel}
    />
  )
}
