import { useState } from 'react'
import { useNow } from '../../lib/useNow'
import { recheckMac } from '../connect'
import { CLOCK_TICK_MS, RETRY_WINDOW_MS } from '../constants'
import { checkedLabel } from '../format'
import { useMobile } from '../state'
import { MobileScreen, PrimaryButton } from '../ui'
import { MIN_SERVER_VERSION } from '../version'

/**
 * 9i (spec § 5): the Mac refused our protocol, or runs an Orbital older than
 * MIN_SERVER_VERSION. The whole app waits behind this. "Try again" is one
 * bounded reconnect and hello (RETRY_WINDOW_MS); every return to the
 * foreground checks again (`boot.ts`), and a new-enough hello leaves for
 * the list by itself (`reduce`).
 */
export function MismatchScreen() {
  const mismatch = useMobile((s) => s.mismatch)
  const checkedAt = useMobile((s) => s.checkedAt)
  const macName = useMobile((s) => s.macName)
  const [trying, setTrying] = useState(false)
  const now = useNow(checkedAt !== null, CLOCK_TICK_MS)
  const needed = mismatch?.needed ?? MIN_SERVER_VERSION
  const mac = macName ?? 'Your Mac'
  const macVersion = mismatch?.macVersion ?? null

  const tryAgain = async () => {
    setTrying(true)
    await recheckMac(RETRY_WINDOW_MS)
    setTrying(false)
  }

  return (
    <MobileScreen>
      <div className="flex flex-col gap-5 px-6 pt-20">
        <h1 className="text-[22px] font-semibold">Update Orbital on your Mac</h1>
        <p className="text-[14px] text-text-soft">{mac} runs an older Orbital than this app needs.</p>
        <dl className="flex flex-col gap-2 font-mono text-[12px] text-text-muted">
          <div className="flex justify-between gap-3">
            <dt className="truncate">{mac} runs</dt>
            <dd className="shrink-0 text-text-soft">orbital {macVersion ?? 'unknown'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>this app needs</dt>
            <dd className="shrink-0 text-text-soft">orbital ≥ {needed}</dd>
          </div>
        </dl>
        <p className="text-[14px] text-text-soft">On the Mac: Orbital → Check for Updates…</p>
        <PrimaryButton disabled={trying} onClick={() => void tryAgain()}>
          {trying ? 'Checking…' : 'Try again'}
        </PrimaryButton>
        {checkedAt !== null && (
          <p className="font-mono text-[11px] text-text-muted">
            {macVersion ? `still ${macVersion} · ` : ''}
            {checkedLabel(checkedAt, now)}
          </p>
        )}
      </div>
    </MobileScreen>
  )
}
