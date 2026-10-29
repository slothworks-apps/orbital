import { useCallback, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { confirmRewind, useRewindUi } from '../store/rewind'
import { rewindConfirmation } from '../lib/rewind'
import { command, matches } from '../lib/keymap'
import { useNow } from '../lib/useNow'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { openToolUse } from './Transcript'
import { salientInput } from './ToolRow'

/**
 * The stop dialog a pick opens when something is still running (spec
 * 2026-09-29-rewind-design § Behaviour 4; canvas 27b in the window, 27c
 * WHEN THE STOP DIALOG ASKS for the copy). `StopDialog`'s shell — amber
 * frame, pulsing eyebrow — with the list of what ends and the two fixed
 * buttons. It asks only; the server stops the session when the pick is sent.
 *
 * Mounted beside the panel's other session dialogs, so it is modal to its
 * own window (27b: "modal to its own window only").
 */
export function RewindDialog({ sessionId }: { sessionId: string }) {
  const picked = useRewindUi((s) => (s.picked?.sessionId === sessionId && s.picked.confirming ? s.picked : null))
  const dismissConfirm = useRewindUi((s) => s.dismissConfirm)
  const open = picked !== null
  const session = useOrbital((s) => s.sessions[sessionId])
  const messages = useOrbital(useShallow((s) => (open ? (s.transcripts[sessionId] ?? []) : [])))
  const now = useNow(open)

  const openTool = open ? openToolUse(messages) : undefined
  const turn = openTool
    ? {
        label: [openTool.toolName, salientInput(openTool.toolName, openTool.toolInput)].filter(Boolean).join(': '),
        startedAt: openTool.timestamp ? Date.parse(openTool.timestamp) : undefined,
      }
    : null
  // Read live, so the elapsed times count up. Should everything end while the
  // dialog is up, it stays until answered, on the plain working copy — it
  // does not vanish under the pointer.
  const confirmation = session ? rewindConfirmation(session, turn, now) : null

  const handleConfirm = useCallback(() => confirmRewind(), [])

  // ⏎ confirms, as on the stop dialog.
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matches(command('dialogs.confirm').chords[0], e)) return
      e.preventDefault()
      handleConfirm()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, handleConfirm])

  return (
    <Dialog
      open={open}
      title={confirmation?.title ?? 'Stop the session and rewind?'}
      eyebrow={confirmation?.eyebrow ?? 'SESSION IS WORKING'}
      size="sm"
      tone="warning"
      eyebrowPulse
      onClose={dismissConfirm}
      footerCaption="esc cancel"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={dismissConfirm}>
            Keep running
          </Button>
          <Button variant="warning" size="lg" onClick={handleConfirm}>
            <span aria-hidden className="h-2 w-2 rounded-[1px] bg-current" />
            Stop and rewind
          </Button>
        </>
      }
    >
      {/* Canvas 27b/27c: body 13/1.55, the list 14px under it, the note 12px under that. */}
      <div className="flex flex-col">
        <p className="fs-13 leading-[1.55] text-ink-600/85 [text-wrap:pretty]">
          {confirmation?.body}
        </p>
        {confirmation && confirmation.items.length > 0 && (
          <ul
            data-rewind-confirm-items
            className="mt-3.5 flex flex-col rounded-lg border border-line/10 bg-space/45 py-1"
          >
            {confirmation.items.map((item, i) => (
              <li
                key={i}
                className="flex items-center gap-2 px-3 py-1.5 font-mono fs-11 text-ink-900/75"
              >
                <span aria-hidden className="w-3 shrink-0 text-ink-900/55">
                  {item.glyph}
                </span>
                <span className="shrink-0 text-ink-900/60">{item.kind}</span>
                <span className="min-w-0 truncate text-ink-100">{item.label}</span>
                <span aria-hidden className="flex-1" />
                {item.elapsed && (
                  // oklch(80% .13 60): the amber of the frame's glow.
                  <span className="shrink-0 whitespace-nowrap text-warning">{item.elapsed}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 fs-12 leading-[1.55] text-ink-900/70 [text-wrap:pretty]">
          Files on disk stay as they are. You can still cancel the rewind afterwards, but ended tasks
          don&apos;t restart.
        </p>
      </div>
    </Dialog>
  )
}
