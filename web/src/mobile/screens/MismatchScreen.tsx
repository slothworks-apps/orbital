import { useState } from 'react'
import { useNow } from '../../lib/useNow'
import { CLOCK_TICK_MS, RETRY_WINDOW_MS } from '../constants'
import { checkedLabel } from '../format'
import { useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
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
  const [trying, setTrying] = useState(false)
  const now = useNow(checkedAt !== null, CLOCK_TICK_MS)
  const needed = mismatch?.needed ?? MIN_SERVER_VERSION

  const tryAgain = async () => {
    setTrying(true)
    await clientRef.recheck(RETRY_WINDOW_MS)
    useMobile.setState({ checkedAt: Date.now() })
    setTrying(false)
  }

  return (
    <MobileScreen>
      <div className="flex flex-col gap-5 px-6 pt-20">
        <h1 className="text-[22px] font-semibold">Update Orbital on the Mac</h1>
        <p className="text-[14px] text-text-soft">This phone needs Orbital {needed} or newer on the Mac.</p>
        <dl className="flex flex-col gap-2 font-mono text-[12px] text-text-muted">
          <div className="flex justify-between">
            <dt>Mac</dt>
            <dd className="text-text-soft">{mismatch?.macVersion ?? 'unknown'}</dd>
          </div>
          <div className="flex justify-between">
            <dt>this phone</dt>
            <dd className="text-text-soft">orbital mobile {__MOBILE_VERSION__}</dd>
          </div>
        </dl>
        <PrimaryButton disabled={trying} onClick={() => void tryAgain()}>
          Try again
        </PrimaryButton>
        {checkedAt !== null && <p className="font-mono text-[11px] text-text-muted">{checkedLabel(checkedAt, now)}</p>}
      </div>
    </MobileScreen>
  )
}
