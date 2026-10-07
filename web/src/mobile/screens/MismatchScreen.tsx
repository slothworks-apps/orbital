import { useState, type ReactNode } from 'react'
import { useNow } from '../../lib/useNow'
import { recheckMac } from '../connect'
import { CLOCK_TICK_MS, RETRY_WINDOW_MS } from '../constants'
import { checkedLabel } from '../format'
import { openStore, storeUrl } from '../platform/store'
import { useMobile, type Mismatch } from '../state'
import { NoticeScreen, PrimaryButton, SecondaryButton } from '../ui'
import { MIN_SERVER_VERSION } from '../version'

/**
 * 9i (spec § 5; spec 2026-10-07-version-compatibility-design § 5): a part
 * is too old for the others — the Mac refused our protocol or runs an
 * Orbital older than MIN_SERVER_VERSION (`mac`), the relay is older than
 * this app needs (`relay`), or the Mac refused this app as too old (`app`).
 * The whole app waits behind this. "Try again" is one bounded reconnect and
 * hello (RETRY_WINDOW_MS); every return to the foreground checks again
 * (`boot.ts`), and a hello, or for `relay` the relay's `ok`, leaves for the
 * list by itself (`reduce`).
 *
 * The canvas draws only the `mac` variant; the `relay` and `app` copy is
 * provisional until Claude Design draws them.
 */
export function MismatchScreen() {
  const mismatch = useMobile((s) => s.mismatch)
  const checkedAt = useMobile((s) => s.checkedAt)
  const macName = useMobile((s) => s.macName)
  const relayUrl = useMobile((s) => s.pairing?.relay ?? null)
  const [trying, setTrying] = useState(false)
  const now = useNow(checkedAt !== null, CLOCK_TICK_MS)
  const cause = mismatch?.cause ?? 'mac'
  const theirs = mismatch?.theirs ?? null
  const mac = macName ?? 'Your Mac'
  const store = cause === 'app' ? storeUrl() : null

  const tryAgain = async () => {
    setTrying(true)
    await recheckMac(RETRY_WINDOW_MS)
    setTrying(false)
  }
  const tryAgainLabel = trying ? 'Checking…' : 'Try again'

  return (
    <NoticeScreen
      actions={
        <>
          {checkedAt !== null && (
            <p className="text-center font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
              {theirs ? `still ${theirs} · ` : ''}
              {checkedLabel(checkedAt, now)}
            </p>
          )}
          {store ? (
            <>
              <PrimaryButton onClick={() => openStore(store)}>Open Google Play</PrimaryButton>
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
      {cause === 'mac' && <MacTooOld mac={mac} macVersion={theirs} needed={mismatch?.needed ?? MIN_SERVER_VERSION} />}
      {cause === 'relay' && mismatch && <RelayTooOld host={hostOf(relayUrl)} mismatch={mismatch} />}
      {cause === 'app' && mismatch && <AppTooOld mac={mac} needed={mismatch.needed} store={store !== null} />}
    </NoticeScreen>
  )
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

function RelayTooOld({ host, mismatch }: { host: string; mismatch: Mismatch }) {
  return (
    <>
      <Title>Update the relay</Title>
      <Lead>The relay at {host} runs an older version than this app needs.</Lead>
      <Versions
        rows={[
          [`${host} runs`, `relay ${mismatch.theirs ?? 'unknown'}`],
          ...(mismatch.needed ? [['this app needs', `relay ≥ ${mismatch.needed}`] as const] : []),
        ]}
      />
      <Hint>Whoever runs this relay has to update it.</Hint>
    </>
  )
}

function AppTooOld({ mac, needed, store }: { mac: string; needed: string | null; store: boolean }) {
  return (
    <>
      <Title>Update this app</Title>
      <Lead>{mac} needs a newer Orbital on this phone.</Lead>
      <Versions
        rows={[
          ['this app is', `orbital mobile ${__MOBILE_VERSION__}`],
          ...(needed ? [[`${mac} needs`, `orbital mobile ≥ ${needed}`] as const] : []),
        ]}
      />
      {/* Without a store link (iOS), the screen says where the update is. */}
      {!store && <Hint>Update Orbital from the App Store.</Hint>}
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

/** Who runs what, and what is needed: one row each, the value on the right. */
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

/** The relay's host as 9e's "Paired with" names it; the URL itself when it does not parse. */
function hostOf(url: string | null): string {
  if (url === null) return 'your relay'
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
