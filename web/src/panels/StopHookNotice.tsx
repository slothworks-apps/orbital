import { useState } from 'react'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import type { ChatMessage } from '../lib/types'
import { NoticeAction } from './LimitWaitNotice'
import { NoticeRow } from './NoticeRow'

/**
 * The live notice while the session's `Stop` hooks run, with the Cancel that
 * interrupts the session: the server takes an interrupt in that state for
 * the hooks' cancel, and a message waiting behind them is answered at once
 * (spec 2026-10-31-message-beats-stop-hook-design). The row goes when the
 * server takes the notice down; nothing changes here.
 */
export function StopHookNotice({ sessionId, message }: { sessionId: string; message: ChatMessage }) {
  const [busy, setBusy] = useState(false)
  const cancel = () => {
    if (busy) return
    setBusy(true)
    api
      .interrupt(sessionId)
      .catch((err: unknown) => reportError(err, 'Could not cancel the Stop hook'))
      .finally(() => setBusy(false))
  }
  return (
    <NoticeRow
      message={message}
      action={
        <NoticeAction onClick={cancel} disabled={busy}>
          Cancel
        </NoticeAction>
      }
    />
  )
}
