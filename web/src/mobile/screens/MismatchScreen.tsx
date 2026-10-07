import { useState, type ReactNode } from 'react'
import { relayVersionLabel } from '../../lib/remote'
import { useNow } from '../../lib/useNow'
import { recheckMac } from '../connect'
import { CLOCK_TICK_MS, RETRY_WINDOW_MS } from '../constants'
import { checkedLabel, relayHost } from '../format'
import { openStore, storeUrl } from '../platform/store'
import { useMobile, type Mismatch } from '../state'
import { NoticeScreen, PrimaryButton, SecondaryButton } from '../ui'
import { MIN_SERVER_VERSION } from '../version'

/**
 * 9i (spec § 5; spec 2026-10-07-version-compatibility-design § 5, canvas
 * 11a): a part is too old for the others — the Mac refused our protocol or
 * runs an Orbital older than MIN_SERVER_VERSION (`mac`), the relay is older
 * than this app needs (`relay`), or the Mac refused this app as too old
 * (`app`). One family: the same glyph, layout and two-row readout, and only
 * the part named, its versions and the action change. The whole app waits
 * behind this. "Try again" is one bounded reconnect and hello
 * (RETRY_WINDOW_MS); every return to the foreground checks again
 * (`boot.ts`), and a hello, or for `relay` the relay's `ok`, leaves for the
 * list by itself (`reduce`).
 */
export function MismatchScreen() {
  const mismatch = useMobile((s) => s.mismatch)
  const checkedAt = useMobile((s) => s.checkedAt)
  const macName = useMobile((s) => s.macName)
  const relayUrl = useMobile((s) => s.pairing?.relay ?? null)
  const [trying, setTrying] = useState(false)
  /** When "Open Google Play" was tapped; its line stands until a check lands after it. */
  const [storeOpenedAt, setStoreOpenedAt] = useState<number | null>(null)
  const now = useNow(checkedAt !== null, CLOCK_TICK_MS)
  const cause = mismatch?.cause ?? 'mac'
  const theirs = mismatch?.theirs ?? null
  const needed = mismatch?.needed ?? null
  const mac = macName ?? 'Your Mac'
  const host = relayUrl === null ? 'your relay' : relayHost(relayUrl)
  const store = cause === 'app' ? storeUrl() : null

  const tryAgain = async () => {
    setTrying(true)
    await recheckMac(RETRY_WINDOW_MS)
    setTrying(false)
  }
  const tryAgainLabel = trying ? 'Checking…' : 'Try again'

  // canvas 11a: after a check, what is still in the way; after the store, that it re-checks on return.
  const storeLine = storeOpenedAt !== null && (checkedAt === null || storeOpenedAt > checkedAt)
  const result = storeLine
    ? 'opened Google Play · Orbital re-checks when you’re back'
    : checkedAt !== null
      ? [stillLine(cause, mac, theirs, needed), checkedLabel(checkedAt, now)].filter(Boolean).join(' · ')
      : null

  return (
    <NoticeScreen
      actions={
        <>
          {result !== null && (
            <p className="text-center font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">{result}</p>
          )}
          {store ? (
            <>
              <PrimaryButton
                onClick={() => {
                  setStoreOpenedAt(Date.now())
                  openStore(store)
                }}
              >
                Open Google Play
              </PrimaryButton>
              <SecondaryButton disabled={trying} onClick={() => void tryAgain()}>
                {tryAgainLabel}
              </SecondaryButton>
            </>
          ) : (
            <PrimaryButton disabled={trying} onClick={() => void tryAgain()}>
              {tryAgainLabel}
            </PrimaryButton>
          )}
        </>
      }
    >
      {cause === 'mac' && <MacTooOld mac={mac} macVersion={theirs} needed={needed ?? MIN_SERVER_VERSION} />}
      {cause === 'relay' && mismatch && <RelayTooOld mac={mac} host={host} mismatch={mismatch} />}
      {cause === 'app' && mismatch && <AppTooOld mac={mac} needed={needed} store={store !== null} />}
    </NoticeScreen>
  )
}

/**
 * The first half of the result line (canvas 11a): the named part's version,
 * or for `app` the Mac's minimum. Empty when there is nothing to name.
 */
function stillLine(cause: Mismatch['cause'], mac: string, theirs: string | null, needed: string | null): string {
  switch (cause) {
    case 'mac':
      return theirs === null ? '' : `still ${theirs}`
    case 'relay':
      return `still ${theirs ?? 'an older relay'}`
    case 'app':
      return needed === null ? '' : `${mac} still needs ≥ ${needed}`
  }
}

function MacTooOld({ mac, macVersion, needed }: { mac: string; macVersion: string | null; needed: string }) {
  return (
    <>
      <Title>Update Orbital on your Mac</Title>
      <Lead>{mac} runs an older Orbital than this app needs.</Lead>
      <Versions
        rows={[
          [`${mac} runs`, `orbital ${macVersion ?? 'unknown'}`],
          ['this app needs', `orbital ≥ ${needed}`],
        ]}
      />
      <Hint>On the Mac: Orbital → Check for Updates…</Hint>
    </>
  )
}

function RelayTooOld({ mac, host, mismatch }: { mac: string; host: string; mismatch: Mismatch }) {
  return (
    <>
      <Title>The relay needs an update</Title>
      <Lead>
        {mac} connects through <span className="font-mono text-text-bright">{host}</span>, which is older than this app
        supports.
      </Lead>
      <Versions
        rows={[
          [`${host} runs`, relayVersionLabel(mismatch.theirs)],
          ...(mismatch.needed ? [['this app needs', `relay ≥ ${mismatch.needed}`] as const] : []),
        ]}
      />
      <Hint>Nothing to change on this phone — whoever runs the relay updates its image.</Hint>
    </>
  )
}

function AppTooOld({ mac, needed, store }: { mac: string; needed: string | null; store: boolean }) {
  return (
    <>
      <Title>Update Orbital on this phone</Title>
      <Lead>{mac} needs a newer Orbital app than this one.</Lead>
      <Versions
        rows={[
          ['this app runs', `orbital ${__MOBILE_VERSION__}`],
          ...(needed ? [[`${mac} needs`, `orbital ≥ ${needed}`] as const] : []),
        ]}
      />
      {/* Without a store link (iOS: no App Store id yet), the hint still says where the update is. */}
      <Hint>{store ? 'The update is in Google Play.' : 'The update is in the App Store.'}</Hint>
    </>
  )
}

function Title({ children }: { children: ReactNode }) {
  return <h1 className="mt-3.5 text-[24px] font-bold tracking-[-0.01em] [text-wrap:balance]">{children}</h1>
}

function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-[300px] text-[14px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">{children}</p>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[12.5px] leading-[1.5] text-[rgba(160,190,225,.65)]">{children}</p>
}

/** Who runs what, and what is needed (canvas 11a, 11d D): one row each, the value on the right. */
function Versions({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="mt-2 flex w-full flex-col rounded-[14px] border border-[rgba(150,205,255,.12)] bg-[rgba(10,16,28,.6)] text-left font-mono text-[12px] text-[rgba(160,190,225,.65)]">
      {rows.map(([term, value], i) => (
        <div key={term} className={['flex gap-3 px-3.5 py-[13px]', i > 0 ? 'border-t border-[rgba(150,205,255,.08)]' : ''].join(' ')}>
          <dt className="min-w-0 truncate">{term}</dt>
          <dd className="ml-auto shrink-0 text-text-bright">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
