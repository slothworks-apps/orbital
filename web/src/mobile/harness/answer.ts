import { api } from '../../lib/api'
import { rewindCountFor } from '../../lib/harness'
import type { SessionHarness, StepState } from '../../lib/types'
import { confirmRewind, pickRewindTarget, useRewindUi } from '../../store/rewind'
import { useOrbital } from '../../store/store'
import { humanizeError } from '../composer'
import { useMobile } from '../state'

/**
 * The gate card's answers (spec 2026-10-05-mobile-next § 1). The desktop's
 * `act` does the same two things on success — the harness the route answers
 * with goes into the store, and the store reads it again — but a failure
 * there is a toast, which the phone's composer would take as its own error.
 * The card says it under itself instead, so each answer returns its failure
 * in words, or null.
 */
async function answer(sessionId: string, call: () => Promise<{ harness: SessionHarness }>): Promise<string | null> {
  try {
    const { harness } = await call()
    useOrbital.setState((s) => ({ harnesses: { ...s.harnesses, [sessionId]: harness } }))
    void useOrbital.getState().loadHarness(sessionId)
    return null
  } catch (err) {
    return humanizeError(err instanceof Error ? err.message : String(err), useMobile.getState().macName)
  }
}

export const approveStep = (sessionId: string, index: number) =>
  answer(sessionId, () => api.approveHarnessStep(sessionId, index))

export const reopenStep = (sessionId: string, index: number) =>
  answer(sessionId, () => api.reopenHarnessStep(sessionId, index))

export const decideMyself = (sessionId: string, index: number) =>
  answer(sessionId, () => api.decideHarnessStepMyself(sessionId, index))

const MESSAGE_GONE = 'The message that began this step is no longer in the conversation.'

/** Resolves once no rewind pick of `messageId` is in flight (`startRewind` clears it, either way). */
function rewindSettled(messageId: string): Promise<void> {
  return new Promise((resolve) => {
    const done = () => useRewindUi.getState().picked?.messageId !== messageId
    if (done()) return resolve()
    const stop = useRewindUi.subscribe(() => {
      if (!done()) return
      stop()
      resolve()
    })
  })
}

/**
 * Go back, as the desktop's `goBackToStep` does it — the checklist goes back
 * to the step, the conversation rewinds to the message that began it — and
 * then the rewound message is sent at once (spec Decision 6; the desktop
 * leaves it in its composer). The sheet has already asked, so the rewind's
 * own stop confirm is answered here. The rewind's own refusal stays the
 * store's toast, which the composer's line shows.
 */
export async function goBackFromPhone(sessionId: string, index: number, state: StepState): Promise<string | null> {
  const uuid = state.startMessageUuid
  if (!uuid) return MESSAGE_GONE
  const store = useOrbital.getState()
  // The message may sit in history the transcript has not paged in yet.
  let messages = store.transcripts[sessionId] ?? []
  for (let page = 0; page < 20 && !messages.some((m) => m.uuid === uuid); page++) {
    const older = await store.loadOlder(sessionId)
    if (!older || older.length === 0) break
    messages = useOrbital.getState().transcripts[sessionId] ?? []
  }
  const message = messages.find((m) => m.uuid === uuid)
  if (!message) return MESSAGE_GONE

  const failed = await answer(sessionId, () => api.goBackHarnessStep(sessionId, index))
  if (failed) return failed

  pickRewindTarget(sessionId, message, rewindCountFor(messages, uuid) ?? 0)
  if (useRewindUi.getState().picked?.confirming) confirmRewind()
  await rewindSettled(message.id)

  const text = useOrbital.getState().sessions[sessionId]?.rewindPending?.text
  if (text === undefined) return null
  useOrbital.getState().setComposerDraft(sessionId, '')
  await useOrbital.getState().sendPrompt(sessionId, text)
  return null
}
