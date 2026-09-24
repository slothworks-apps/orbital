import { useState, type KeyboardEvent } from 'react'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import type { ApiSession, WalkthroughStep } from '../lib/types'
import { midTurn, refusalOf } from './derive'
import { BlinkDot } from './parts'

const WORKING = 'the session is working — asking waits until it settles'
const PARKED = 'the session is waiting on a decision — asking waits until it settles'
const NOT_OURS = 'this session is not Orbital\'s to continue'

interface AskFieldProps {
  id: string
  step: WalkthroughStep
  session: ApiSession
  onSent(): void
}

/**
 * Ask the session about this step (spec § Asking). One turn, sent through
 * the composer's route; refused mid-turn, because a question injected into a
 * running turn is not the question it appears to be. The answer arrives on
 * the session's topic, which the page already refetches on.
 */
export function AskField({ id, step, session, onSent }: AskFieldProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const busy = midTurn(session)
  const disabled = busy || sending

  const send = () => {
    const question = text.trim()
    if (!question || disabled) return
    setSending(true)
    setProblem(null)
    api.askWalkthrough(id, step.id, question).then(
      () => {
        setSending(false)
        setText('')
        onSent()
      },
      (err: unknown) => {
        setSending(false)
        const why = refusalOf(err)
        if (why === 'busy') setProblem(WORKING)
        else if (why === 'terminal_session') setProblem(NOT_OURS)
        else {
          reportError(err, 'Could not send the question')
          setProblem('could not send')
        }
      },
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Only the keys the field handles itself stop here; everything else
    // bubbles to the window, where the page's arrow handler already ignores a
    // caret in a textarea and the app's one keydown listener decides whether
    // a chord fires while typing. Escape only lets go of the field, and the
    // next one goes to the map (25h).
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.currentTarget.blur()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.stopPropagation()
      e.preventDefault()
      send()
    }
  }

  const line = busy ? (session.status === 'working' ? WORKING : PARKED) : problem ?? '⏎ ask · one turn, answered by this session'

  // canvas 21b: the ask well. Disabled, the placeholder dims and the hint
  // brightens behind a blinking dot — the reason is the thing to read.
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.6)] px-3 pt-3 pb-2.5 focus-within:border-[rgba(150,205,255,.3)]">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={2}
        placeholder="ask the session about this step…"
        className="w-full resize-none bg-transparent text-[13.5px] leading-[1.62] text-text-bright outline-none placeholder:text-[rgba(160,190,225,.5)] disabled:cursor-not-allowed disabled:placeholder:text-[rgba(160,190,225,.35)]"
      />
      <span
        className={[
          'flex items-center gap-2 font-mono text-[10px] tracking-[.06em]',
          busy ? 'text-[rgba(200,220,245,.75)]' : 'text-[rgba(160,190,225,.5)]',
        ].join(' ')}
      >
        {busy && <BlinkDot />}
        {line}
      </span>
    </div>
  )
}
