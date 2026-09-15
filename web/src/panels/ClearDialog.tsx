import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'

export interface ClearDialogProps {
  open: boolean
  sessionId: string | null
  onClose: () => void
}

/**
 * Confirms `/clear`ing a session's transcript (artboard 1g). "Clear only"
 * ends the turn and wipes history; "Clear & start new" also spawns a
 * follow-on session (server response carries the new `sessionId`), which
 * this dialog then selects. "Don't ask again" persists
 * `confirm_before_clear: 'false'` so `DetailPanel`'s header Clear button
 * skips this dialog entirely next time (clear-only, per the task ruling).
 */
export function ClearDialog({ open, sessionId, onClose }: ClearDialogProps) {
  const settings = useOrbital(useShallow((s) => s.settings))
  const session = useOrbital((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const tags = useOrbital(useShallow((s) => s.tags))

  const [lineageLength, setLineageLength] = useState<number | null>(null)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) {
      setDontAskAgain(false)
      setLineageLength(null)
      return
    }
    if (!sessionId) return
    let cancelled = false
    api
      .getSession(sessionId)
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
  }, [open, sessionId])

  async function handleClear(startNew: boolean) {
    if (!sessionId || pending) return
    setPending(true)
    try {
      if (dontAskAgain) {
        useOrbital.setState((state) => ({
          settings: { ...state.settings, confirm_before_clear: 'false' },
        }))
        await api.patchSettings({ confirm_before_clear: 'false' })
      }
      const result = await api.clearSession(sessionId, startNew)
      if (startNew && result.sessionId) {
        void useOrbital.getState().select(result.sessionId)
      }
      onClose()
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
      title="/CLEAR — Clear and start a new session?"
      onClose={onClose}
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
        <label className="flex items-center gap-2 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
          />
          Don&apos;t ask again
        </label>
      </div>
    </Dialog>
  )
}
