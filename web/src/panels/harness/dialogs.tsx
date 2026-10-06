import { useEffect, useRef, useState } from 'react'
import { Dialog } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { copyToClipboard } from '../../lib/clipboard'
import type { SessionHarness } from '../../lib/types'
import { finishedSince, pad2, shortSha, stepRange, stepsGoingBack } from './model'

/** "Copy" → "Copied" for this long (30e). */
export const COPIED_MS = 2000

/**
 * Remove (canvas 30b, the dialog under ⋯ → Remove harness…): the only harness
 * control with a confirmation, in Orbital's dialog shell (30f RULES).
 */
export function RemoveDialog({
  open,
  harness,
  onClose,
  onRemove,
}: {
  open: boolean
  harness: SessionHarness
  onClose: () => void
  onRemove: () => void
}) {
  const done = harness.state.filter((s) => s.status === 'done').length
  return (
    <Dialog
      open={open}
      size="sm"
      eyebrow={`HARNESS · ${harness.name.toUpperCase()}`}
      title="Remove the harness from this session?"
      onClose={onClose}
      footerCaption="esc cancel"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="primary" size="lg" onClick={onRemove}>
            Remove harness
          </Button>
        </>
      }
    >
      <p className="text-pretty text-[13px] leading-[1.55] text-[rgba(200,214,235,.85)]">
        The agent stops following the steps and Orbital stops sending it on. The conversation, the files and the
        commits stay as they are.
      </p>
      {done > 0 && (
        <p className="mt-3 text-pretty text-[12px] leading-[1.55] text-[rgba(160,190,225,.7)]">
          The {done === 1 ? 'finished step keeps its record' : `${done} finished steps keep their records`}. You can
          still read them from session stats → Harness.
        </p>
      )}
    </Dialog>
  )
}

/**
 * "Go back here" (canvas 30e, THE REWIND V2 DIALOG): which steps become
 * pending, and the git line that would put the code back — copyable, never
 * run. While a turn or task runs it is the amber "Stop the session and go
 * back?" variant.
 */
export function GoBackDialog({
  harness,
  index,
  running,
  onClose,
  onConfirm,
}: {
  harness: SessionHarness
  index: number | null
  running: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(t)
  }, [copied])

  const open = index !== null
  // Held through the close transition, so the copy does not change under the fade.
  const last = useRef(0)
  if (index !== null) last.current = index
  const i = last.current
  const state = harness.state[i]
  const going = stepsGoingBack(harness, i)
  const range = stepRange(going)
  const kept = finishedSince(harness, i)
  const n = i + 1
  const git = state?.startHead ? `git reset --hard ${shortSha(state.startHead)}` : null

  return (
    <Dialog
      open={open}
      size="sm"
      tone={running ? 'warning' : 'accent'}
      eyebrow={`GO BACK · STEP ${pad2(n)}`}
      title={running ? 'Stop the session and go back?' : `Rewind to the start of step ${n}?`}
      onClose={onClose}
      footerCaption="esc cancel"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={running ? 'warning' : 'primary'} size="lg" onClick={onConfirm}>
            {running ? 'Stop and go back' : '↶ Go back here'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col">
        <p className="text-pretty text-[13px] leading-[1.55] text-[rgba(200,214,235,.85)]">
          {running && 'The turn and anything running in the session stop. '}
          The conversation goes back to the message that sent the agent on to step {n}.{' '}
          {going.length > 1
            ? `Steps ${range} become pending again. Their records stay readable, marked “before going back”.`
            : `Step ${n} becomes pending again. Its record stays readable, marked “before going back”.`}
        </p>
        {going.length > 0 && (
          <ul className="mt-3.5 flex flex-col rounded-lg border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] py-1">
            {going.map((k) => (
              <li key={k} className="flex items-center gap-2 px-3 py-1.5 font-mono text-[11px] text-[rgba(160,190,225,.75)]">
                <span aria-hidden className="w-3 shrink-0 text-[rgba(160,190,225,.55)]">
                  {harness.steps[k].mode === 'gate' ? '◆' : '●'}
                </span>
                <span className="shrink-0 text-[#e8eef8]">{pad2(k + 1)}</span>
                <span className="min-w-0 truncate">{harness.steps[k].title}</span>
                <span aria-hidden className="flex-1" />
                <span className="shrink-0">→ pending</span>
              </li>
            ))}
          </ul>
        )}
        {kept.length > 0 && (
          <p className="mt-3 text-pretty text-[12px] leading-[1.55] text-[rgba(160,190,225,.7)]">
            {kept.length > 1 ? `Steps ${stepRange(kept)} stay done` : `Step ${kept[0] + 1} stays done`}: another branch, finished
            after step {n} began. The conversation goes back past {kept.length > 1 ? 'them' : 'it'}, and the reset below would
            drop {kept.length > 1 ? 'their' : 'its'} commits too.
          </p>
        )}
        {git && state?.startHead && (
          <>
            <p className="mt-3 text-pretty text-[12px] leading-[1.55] text-[rgba(160,190,225,.7)]">
              Files on disk stay as they are. To put the code back too, run this in the project after the rewind:
            </p>
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-[rgba(150,205,255,.12)] bg-[rgba(2,4,9,.7)] py-2 pl-3 pr-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[rgba(214,230,248,.92)]">{git}</span>
              <button
                type="button"
                onClick={() => void copyToClipboard(git).then((ok) => ok && setCopied(true))}
                className="shrink-0 rounded-[6px] border border-[rgba(150,205,255,.2)] px-2.5 py-1 font-mono text-[10px] tracking-[0.06em] text-[rgba(220,235,255,.85)] hover:border-[rgba(150,205,255,.35)] hover:text-[#e8eef8]"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="mt-1.5 font-mono text-[9.5px] text-[rgba(160,190,225,.5)]">
              {shortSha(state.startHead)} = the commit step {n} started from · Orbital never runs it for you
            </div>
          </>
        )}
        {!git && (
          <p className="mt-3 text-pretty text-[12px] leading-[1.55] text-[rgba(160,190,225,.7)]">Files on disk stay as they are.</p>
        )}
      </div>
    </Dialog>
  )
}
