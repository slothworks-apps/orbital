import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { command, matches } from '../lib/keymap'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { harnessUnfinished } from '../lib/harnessSession'
import type { SessionHarness } from '../lib/types'

/** `Build a component · step 4 of 7`: the harness and where the new session picks it up. */
function carriedStep(harness: SessionHarness): string {
  const at = harness.state.findIndex((s) => s.status !== 'done')
  return `${harness.name} · step ${at + 1} of ${harness.steps.length}`
}

export interface ClearDialogProps {
  open: boolean
  sessionId: string | null
  onClose: () => void
}

/**
 * Confirms `/clear`ing a session's transcript (artboard 1g): "Clear & start
 * new" ends the session and spawns a follow-on one (server response carries
 * the new `sessionId`), which this dialog then selects. There is no "Clear
 * only" any more — ending without a successor is the header's End session
 * (spec 2026-09-23-end-session-design). "Don't ask again" persists
 * `confirm_before_clear: 'false'` so `DetailPanel`'s header Clear button
 * skips this dialog entirely next time and does the same clear-and-start-new.
 */
export function ClearDialog({ open, sessionId, onClose }: ClearDialogProps) {
  const tags = useOrbital(useShallow((s) => s.tags))

  // Captured at the moment the dialog opens, not the live `sessionId` prop —
  // see StopDialog for the same reasoning: the selection can change
  // elsewhere while this dialog is still open.
  const [targetId, setTargetId] = useState<string | null>(null)
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) setTargetId(sessionId)
    wasOpenRef.current = open
  }, [open, sessionId])

  const session = useOrbital((s) => (targetId ? s.sessions[targetId] : undefined))
  // A harness with steps left — running, or paused because the session
  // ended — can go on in the new session (spec 2026-10-02-harness-redesign-design
  // § 8). Offered, and on by default: the plan is why the session ran, and
  // Clear is how the "session ended" pause says to continue it.
  const harness = useOrbital((s) => (targetId ? s.harnesses[targetId] : undefined))
  const carryable = harnessUnfinished(harness) ? harness : null

  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [carryHarness, setCarryHarness] = useState(true)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) {
      setDontAskAgain(false)
      setCarryHarness(true)
      setPending(false)
    }
  }, [open])

  async function persistDontAskAgain() {
    if (!dontAskAgain) return
    try {
      // Await the API call BEFORE touching the store — a rejected PATCH
      // must never leave the store claiming a preference the server never
      // actually saved.
      await api.patchSettings({ confirm_before_clear: 'false' })
      useOrbital.setState((state) => ({
        settings: { ...state.settings, confirm_before_clear: 'false' },
      }))
    } catch (err) {
      reportError(err, 'Failed to save "don\'t ask again"')
      // Non-fatal to the clear itself — the user's primary action (clearing)
      // still proceeds; only the "don't ask again" preference didn't stick.
    }
  }

  const handleClear = useCallback(
    async () => {
      if (!targetId || pending) return
      setPending(true)
      try {
        await persistDontAskAgain()
        const result = carryable && carryHarness
          ? await api.clearSession(targetId, true, { carryHarness: true })
          : await api.clearSession(targetId, true)
        if (result.sessionId) {
          void useOrbital.getState().select(result.sessionId)
        }
        onClose()
      } catch (err) {
        reportError(err, 'Failed to clear session')
      } finally {
        setPending(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetId, pending, dontAskAgain, carryable, carryHarness, onClose],
  )

  // ⏎ clears and starts a new session ("esc · ⏎ new"). Ending without a
  // successor is the header's End session now (spec
  // 2026-09-23-end-session-design), so ⇧⏎ no longer means "clear only".
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matches(command('dialogs.confirm').chords[0], e)) return
      e.preventDefault()
      void handleClear()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, handleClear])

  const tagNames = (session?.tagIds ?? [])
    .map((id) => tags.find((t) => t.id === id)?.name)
    .filter((name): name is string => Boolean(name))

  return (
    <Dialog
      open={open}
      title="Clear and start a new session?"
      // Lowercase per the spec, not the export's "/CLEAR".
      eyebrow="/clear"
      onClose={onClose}
      footerCaption="esc · ⏎ new"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" onClick={() => void handleClear()} disabled={pending}>
            <span aria-hidden className="text-sm leading-none">
              ↻
            </span>
            Clear &amp; start new
          </Button>
        </>
      }
    >
      <div className="flex flex-col">
        {/* Copy + geometry from canvas 1g. */}
        <p className="text-[13px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
          {session?.title && (
            <span className="font-mono text-text-bright">{session.title}</span>
          )}
          {session?.title ? ' ends' : 'This session ends'} and moves to history. A new session starts in
          the same project and inherits its settings.
        </p>

        <div className="mt-3.5 rounded-[9px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-3.5 py-3 font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.75)]">
          <div className="truncate">
            {session?.permissionMode ?? 'mode'} ·{' '}
            {tagNames.length > 0 ? tagNames.join(', ') : 'tags'} · same directory
          </div>
        </div>

        {carryable && (
          <div className="mt-3">
            <Checkbox
              checked={carryHarness}
              onChange={setCarryHarness}
              label={
                <span className="text-[12px] text-[rgba(160,190,225,.75)]">
                  Continue the harness in the new session{' '}
                  <span className="font-mono text-[10px] text-[rgba(160,190,225,.5)]">
                    ({carriedStep(carryable)})
                  </span>
                </span>
              }
            />
          </div>
        )}

        <div className="mt-3">
          <Checkbox
            checked={dontAskAgain}
            onChange={setDontAskAgain}
            label={
              <span className="text-[12px] text-[rgba(160,190,225,.75)]">
                Don&apos;t ask again{' '}
                <span className="font-mono text-[10px] text-[rgba(160,190,225,.5)]">
                  (Settings → Sessions)
                </span>
              </span>
            }
          />
        </div>
      </div>
    </Dialog>
  )
}
