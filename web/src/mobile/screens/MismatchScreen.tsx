import { useState } from 'react'
import { useNow } from '../../lib/useNow'
import { recheckMac } from '../connect'
import { CLOCK_TICK_MS, RETRY_WINDOW_MS } from '../constants'
import { checkedLabel } from '../format'
import { useMobile } from '../state'
import { NoticeScreen, PrimaryButton } from '../ui'
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
    <NoticeScreen
      actions={
        <>
          {checkedAt !== null && (
            <p className="text-center font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
              {macVersion ? `still ${macVersion} · ` : ''}
              {checkedLabel(checkedAt, now)}
            </p>
          )}
          <PrimaryButton disabled={trying} onClick={() => void tryAgain()}>
            {trying ? 'Checking…' : 'Try again'}
          </PrimaryButton>
        </>
      }
    >
      <h1 className="mt-3.5 text-[24px] font-bold tracking-[-0.01em] [text-wrap:balance]">Update Orbital on your Mac</h1>
      <p className="max-w-[300px] text-[14px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
        {mac} runs an older Orbital than this app needs.
      </p>
      <dl className="mt-2 flex w-full flex-col rounded-[14px] border border-[rgba(150,205,255,.12)] bg-[rgba(10,16,28,.6)] text-left font-mono text-[12px] text-[rgba(160,190,225,.65)]">
        <div className="flex gap-3 px-3.5 py-[13px]">
          <dt className="min-w-0 truncate">{mac} runs</dt>
          <dd className="ml-auto shrink-0 text-text-bright">orbital {macVersion ?? 'unknown'}</dd>
        </div>
        <div className="flex gap-3 border-t border-[rgba(150,205,255,.08)] px-3.5 py-[13px]">
          <dt>this app needs</dt>
          <dd className="ml-auto shrink-0 text-text-bright">orbital ≥ {needed}</dd>
        </div>
      </dl>
      <p className="text-[12.5px] leading-[1.5] text-[rgba(160,190,225,.65)]">On the Mac: Orbital → Check for Updates…</p>
    </NoticeScreen>
  )
}
