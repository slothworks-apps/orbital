import { useOrbital } from '../../store/store'
import { api } from '../../lib/api'
import { reportError } from '../../lib/errors'
import type { SessionHarness, StepState } from '../../lib/types'
import { rewindCountFor } from '../../lib/harness'
import { confirmRewind, pickRewindTarget, useRewindUi } from '../../store/rewind'

/** Runs a harness route and puts the harness it answers with into the store. */
export async function act(
  sessionId: string,
  label: string,
  call: () => Promise<{ harness: SessionHarness } | void>,
): Promise<boolean> {
  try {
    const result = await call()
    if (result) useOrbital.setState((s) => ({ harnesses: { ...s.harnesses, [sessionId]: result.harness } }))
    void useOrbital.getState().loadHarness(sessionId)
    return true
  } catch (err) {
    reportError(err, label)
    return false
  }
}

/** Runs a harness route for a dialog: the error it answered with, to show there, or null when it went through. */
export async function attempt(sessionId: string, call: () => Promise<{ harness: SessionHarness }>): Promise<string | null> {
  try {
    const { harness } = await call()
    useOrbital.setState((s) => ({ harnesses: { ...s.harnesses, [sessionId]: harness } }))
    void useOrbital.getState().loadHarness(sessionId)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'Could not save'
  }
}

/**
 * Whether going back ends something that runs — a turn, a background task, a
 * subagent: then the dialog is Rewind v2's amber "Stop the session and go
 * back?" (canvas 30e), the same test the rewind's own stop dialog uses.
 */
export function somethingRuns(sessionId: string): boolean {
  const session = useOrbital.getState().sessions[sessionId]
  if (!session) return false
  return (
    session.status === 'working' ||
    (session.backgroundTasks ?? []).some((t) => t.state === 'running') ||
    session.subagents.some((s) => s.state !== 'ended')
  )
}

/**
 * "Go back here" (canvas 30e): the checklist goes back to the step (the
 * server keeps the later steps' records as "before going back"), and the
 * conversation rewinds to the message that began it — the existing rewind,
 * whose composer then holds that message to send again. Files are the
 * user's to reset. The dialog has already asked, so the rewind's own stop
 * dialog is answered at once.
 */
export async function goBackToStep(sessionId: string, index: number, state: StepState): Promise<void> {
  const uuid = state.startMessageUuid
  if (!uuid) return
  const store = useOrbital.getState()
  // The message may sit in history the transcript has not paged in yet.
  let messages = store.transcripts[sessionId] ?? []
  for (let page = 0; page < 20 && !messages.some((m) => m.uuid === uuid); page++) {
    const older = await store.loadOlder(sessionId)
    if (!older || older.length === 0) break
    messages = useOrbital.getState().transcripts[sessionId] ?? []
  }
  const message = messages.find((m) => m.uuid === uuid)
  if (!message) {
    useOrbital.setState({ toast: { kind: 'error', message: 'The message that began this step is no longer in the conversation.' } })
    return
  }
  const moved = await act(sessionId, 'Failed to go back', () => api.goBackHarnessStep(sessionId, index))
  if (!moved) return
  pickRewindTarget(sessionId, message, rewindCountFor(messages, uuid) ?? 0)
  if (useRewindUi.getState().picked?.confirming) confirmRewind()
}
