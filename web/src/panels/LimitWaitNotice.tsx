import { useState } from 'react'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { limitSettings, limitWaitCopy } from '../lib/limits'
import { openSettingsSection } from '../lib/sessionUrl'
import type { LimitWait } from '../lib/types'
import { LIMITS_PATH } from '../limits/route'
import { useOrbital } from '../store/store'

/**
 * The transcript's last row while a session waits for a plan limit to reset
 * (spec 2026-10-03-usage-limits-design § 1; canvas `Feature - Plan limits`
 * 31b, 31d "TRANSCRIPT NOTICE — FOUR STATES, ONE ROW"). Three of the four
 * states live here — auto on with Cancel, auto off with the reset time and
 * links, cancelled with Undo; the fourth is the `limit_reset` divider the
 * server writes when the wait fires.
 *
 * Cancel and Undo change nothing locally: the server republishes the
 * session, and the row redraws from its `limitWait`.
 *
 * Messages written during the wait are queued by the server and listed
 * under the row until the reset sends them.
 */
export function LimitWaitNotice({ sessionId, wait, hue }: { sessionId: string; wait: LimitWait; hue: number }) {
  const settings = useOrbital((s) => s.settings)
  const copy = limitWaitCopy(wait, limitSettings(settings))
  const [busy, setBusy] = useState(false)

  const act = () => {
    if (busy || !copy.action) return
    setBusy(true)
    const call = copy.action === 'cancel' ? api.cancelLimitWait(sessionId) : api.undoLimitWait(sessionId)
    call
      .catch((err: unknown) =>
        reportError(err, copy.action === 'cancel' ? 'Could not cancel the auto-continue' : 'Could not undo the cancel'),
      )
      .finally(() => setBusy(false))
  }

  return (
    <div data-limit-wait className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-2 rounded-[9px] border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.5)] px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="block h-2 w-2 flex-none rounded-full border-[1.5px] border-solid border-[rgba(214,230,248,.75)]"
          />
          <span className="min-w-0 flex-1 text-[13px] font-semibold text-text-bright">{copy.title}</span>
          {copy.action && (
            <button
              type="button"
              onClick={act}
              disabled={busy}
              className="cursor-pointer rounded-[7px] border border-[rgba(150,205,255,.18)] bg-transparent px-[11px] py-[5px] text-[12px] font-semibold text-[rgba(220,235,255,.9)] transition-[background-color,border-color] duration-[160ms] ease-[ease] hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.1)] disabled:cursor-default"
            >
              {copy.action === 'cancel' ? 'Cancel' : 'Undo'}
            </button>
          )}
        </div>
        <div className="pl-[18px] font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.65)] [text-wrap:pretty]">
          {copy.sub}
        </div>
        <div className="flex gap-3.5 pl-[18px] font-mono text-[10.5px]">
          <a href={LIMITS_PATH} className="text-[#8fd8ff] no-underline hover:text-[#c6ecff]">
            limits ›
          </a>
          {copy.showSettings && (
            <button
              type="button"
              onClick={() => openSettingsSection('sessions')}
              className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[10.5px] text-[#8fd8ff] hover:text-[#c6ecff]"
            >
              settings ›
            </button>
          )}
        </div>
      </div>
      {wait.queued.map((text, i) => (
        // A message written during the wait, held by the server until the
        // reset: the user's bubble, dashed, because it has not gone out yet.
        <div key={i} data-limit-queued className="flex flex-col items-end gap-1">
          <div
            className="max-w-[86%] whitespace-pre-wrap rounded-[12px_12px_4px_12px] border border-dashed px-3.5 py-2.5 text-[13px] leading-[1.5] text-[rgba(232,238,248,.8)] [text-wrap:pretty]"
            style={{ background: `oklch(80% .13 ${hue} / .06)`, borderColor: `oklch(80% .13 ${hue} / .3)` }}
          >
            {text}
          </div>
          <span className="font-mono text-[10px] text-[rgba(160,190,225,.55)]">queued · sent at the reset</span>
        </div>
      ))}
    </div>
  )
}
