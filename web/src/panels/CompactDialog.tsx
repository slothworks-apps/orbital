import { useCallback, useEffect } from 'react'
import { useOrbital } from '../store/store'
import { useCompactionUi } from '../store/compaction'
import { command, matches } from '../lib/keymap'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'

/**
 * Asks before a `/compact` runs past subagents that have not ended (spec
 * 2026-09-28-context-compaction-design § Confirmation when subagents are
 * running). Built the way `StopDialog` is — same shell, same ⏎ confirm —
 * because it is the same kind of question: something is going on, are you
 * sure. Not on the canvas; its fidelity is checked by hand.
 *
 * The request lives in `useCompactionUi` rather than behind a prop, because
 * two places raise it: the composer and the map's `/compact` badge. Cancel
 * sends nothing and leaves any draft where it was.
 */
export function CompactDialog() {
  const confirm = useCompactionUi((s) => s.confirm)
  const setConfirm = useCompactionUi((s) => s.setConfirm)
  const sendPrompt = useOrbital((s) => s.sendPrompt)
  const setComposerDraft = useOrbital((s) => s.setComposerDraft)
  const open = confirm !== null

  const close = useCallback(() => setConfirm(null), [setConfirm])

  const handleCompact = useCallback(() => {
    if (!confirm) return
    setConfirm(null)
    // The composer kept its draft for a Cancel; the command is going out now,
    // so the draft goes with it — whichever route raised the dialog.
    if (useOrbital.getState().composerDrafts[confirm.sessionId]?.trim() === confirm.text.trim()) {
      setComposerDraft(confirm.sessionId, '')
    }
    void sendPrompt(confirm.sessionId, confirm.text)
  }, [confirm, setConfirm, sendPrompt, setComposerDraft])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matches(command('dialogs.confirm').chords[0], e)) return
      e.preventDefault()
      handleCompact()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, handleCompact])

  const count = confirm?.count ?? 0
  return (
    <Dialog
      open={open}
      title={`Compact while ${count} ${count === 1 ? 'subagent is' : 'subagents are'} running?`}
      eyebrow="SUBAGENTS RUNNING"
      size="sm"
      onClose={close}
      footerCaption="esc cancel · ⏎ compact"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" onClick={handleCompact}>
            Compact
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
        {count === 1 ? 'It keeps' : 'They keep'} running and {count === 1 ? 'its result still comes' : 'their results still come'}{' '}
        back. Claude will only remember a summary of why it started {count === 1 ? 'it' : 'them'}.
      </p>
    </Dialog>
  )
}
