import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { command, matches } from '../lib/keymap'
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

/** The lineage preview orbs of canvas 1g: the ending session dimmed, the
 * successor drawn as a dashed "materializing" ring. The export animates the
 * ring; we reuse the shared `orbital-pulse` treatment since the export's
 * `orb-mat` keyframes live outside the files this panel owns. */
function LineagePreviewOrbs() {
  return (
    <div aria-hidden className="flex shrink-0 items-center">
      <span className="block h-[26px] w-[26px] rounded-full border border-[rgba(200,215,235,.35)] bg-[#0b141d] opacity-60" />
      <span className="mx-1.5 w-11 border-t border-dotted border-accent/50" />
      <span className="relative block h-[26px] w-[26px]">
        <span className="absolute -inset-[5px] rounded-full border border-accent/80 orbital-pulse" />
        <span className="absolute inset-0 rounded-full border border-dashed border-accent/90 bg-[rgba(20,40,55,.6)] shadow-[0_0_24px_rgba(89,228,243,.6)]" />
      </span>
    </div>
  )
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

  const handleClear = useCallback(
    async () => {
      if (!targetId || pending) return
      setPending(true)
      try {
        await persistDontAskAgain()
        const result = await api.clearSession(targetId, true)
        onCleared?.(targetId)
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
    [targetId, pending, dontAskAgain, onClose, onCleared],
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

  const lineageDepth = settings.lineage_depth ?? '3'
  const currentGen = lineageLength !== null ? lineageLength + 1 : null
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
            <span className="font-mono text-text-bright">
              {session.title}
              {currentGen !== null ? ` #${currentGen}` : ''}
            </span>
          )}
          {session?.title ? ' ends' : 'This session ends'} and moves to history. A new session starts in
          the same project and inherits its settings.
        </p>

        <div className="mt-3.5 flex items-center rounded-[9px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-3.5 py-3">
          <LineagePreviewOrbs />
          <div className="ml-4 min-w-0 font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.75)]">
            <div>
              {currentGen !== null ? `#${currentGen} → #${currentGen + 1} · ` : ''}
              lineage keeps last <span className="text-text-bright">{lineageDepth}</span>
            </div>
            <div className="truncate">
              {session?.permissionMode ?? 'mode'} ·{' '}
              {tagNames.length > 0 ? tagNames.join(', ') : 'tags'} · same directory
            </div>
          </div>
        </div>

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
