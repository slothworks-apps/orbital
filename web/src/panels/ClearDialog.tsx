import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'

export interface ClearDialogProps {
  open: boolean
  sessionId: string | null
  onClose: () => void
  /** Called with the cleared session's id right after a successful `clearSession` — lets the caller drop any cached data (e.g. DetailPanel's lineage cache) keyed to it, since a clear can change what `getSession` would now report. */
  onCleared?: (id: string) => void
}

/**
 * Confirms `/clear`ing a session's transcript (artboard 1g). "Clear only"
 * ends the turn and wipes history; "Clear & start new" also spawns a
 * follow-on session (server response carries the new `sessionId`), which
 * this dialog then selects. "Don't ask again" persists
 * `confirm_before_clear: 'false'` so `DetailPanel`'s header Clear button
 * skips this dialog entirely next time (clear-only, per the task ruling).
 */
export function ClearDialog({ open, sessionId, onClose, onCleared }: ClearDialogProps) {
  const settings = useOrbital(useShallow((s) => s.settings))
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

  const [lineageLength, setLineageLength] = useState<number | null>(null)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) {
      setDontAskAgain(false)
      setLineageLength(null)
      setPending(false)
      return
    }
    if (!targetId) return
    let cancelled = false
    api
      .getSession(targetId)
      .then(({ lineage }) => {
        if (!cancelled) setLineageLength(lineage.length)
      })
      .catch(() => {
        // Leave the preview line without a generation count; the dialog is
        // still fully usable without it.
      })
    return () => {
      cancelled = true
    }
  }, [open, targetId])

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

  async function handleClear(startNew: boolean) {
    if (!targetId || pending) return
    setPending(true)
    try {
      await persistDontAskAgain()
      const result = await api.clearSession(targetId, startNew)
      onCleared?.(targetId)
      if (startNew && result.sessionId) {
        void useOrbital.getState().select(result.sessionId)
      }
      onClose()
    } catch (err) {
      reportError(err, 'Failed to clear session')
    } finally {
      setPending(false)
    }
  }

  const lineageDepth = settings.lineage_depth ?? '3'
  const currentGen = lineageLength !== null ? lineageLength + 1 : null
  const tagNames = (session?.tagIds ?? [])
    .map((id) => tags.find((t) => t.id === id)?.name)
    .filter((name): name is string => Boolean(name))

  return (
    <Dialog
      open={open}
      title="Clear and start a new session?"
      eyebrow="/clear"
      onClose={onClose}
      footerCaption="esc cancel · ⏎ start new"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="ghost" onClick={() => void handleClear(false)} disabled={pending}>
            Clear only
          </Button>
          <Button variant="primary" onClick={() => void handleClear(true)} disabled={pending}>
            Clear &amp; start new
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-text-soft">
        <p>
          Clears the current transcript
          {currentGen !== null ? ` — #${currentGen} → #${currentGen + 1}` : ''}
          {' · lineage keeps last '}
          {lineageDepth}.
        </p>
        <p className="font-mono text-xs text-text-muted">
          inherits: {session?.permissionMode ?? 'mode'} · {tagNames.length > 0 ? tagNames.join(', ') : 'tags'} · same
          directory
        </p>
        <Checkbox
          checked={dontAskAgain}
          onChange={setDontAskAgain}
          label={
            <>
              Don&apos;t ask again{' '}
              <span className="font-mono text-[11px] text-text-muted">(Settings → Sessions)</span>
            </>
          }
        />
      </div>
    </Dialog>
  )
}
