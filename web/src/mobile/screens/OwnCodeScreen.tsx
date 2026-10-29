import { useCallback, useEffect, useRef, useState } from 'react'
import type { StartPairingResult } from '@orbital/shared/remote/ceremony'
import { encodePairingCode } from '@orbital/shared/remote/relayApi'
import { copyToClipboard } from '../../lib/clipboard'
import { useNow } from '../../lib/useNow'
import { ownCodeLeft } from '../devices'
import { LEAVE_OFFLINE } from '../forget'
import { useMobile } from '../state'
import { groupRef } from '../transport/groupRef'
import { MobileScreen, PrimaryButton, SecondaryButton } from '../ui'
import { notPrimaryAddLine } from '@orbital/shared/remote/groupWords'

/** What showing a code came to, short of a code. */
function codeError(res: Extract<StartPairingResult, { error: string }>): string {
  const { error } = res
  if (error === 'offline') return LEAVE_OFFLINE
  // In a group, only its primary shows a code that adds a device (canvas 50i).
  if (res.error === 'not_primary') return notPrimaryAddLine(res.primary.name)
  if (error === 'relay_too_old') return 'The relay needs an update before this phone can show a code.'
  // Paired with a primary whose first roster has not come: it adds no one meanwhile.
  if (error === 'joining') return 'This phone is still joining a group. Try again once it has.'
  return "The relay didn't answer. Try again."
}

/** What stands where the code was when a request came while this phone was still joining a group. */
const REFUSED_JOINING = 'This phone is still joining a group, so it took no one. Show a new code once it has.'

/** What stands where the code was when another phone redeemed it: a phone joins through a desktop. */
const REFUSED_PHONE = "A phone can't join another phone. Show this code on a desktop instead."

/** How long Copy reads "Copied" after a copy. */
const COPIED_MS = 1_500

/**
 * This phone's code (canvas 50i "Phone own code"): one word the device being
 * added pastes. Asked for on open; one device per code, so once it is used
 * or runs out the screen offers a new one. The request that follows arrives
 * as the join request sheet, wherever the user is by then.
 */
export function OwnCodeScreen() {
  const goBack = useMobile((s) => s.goBack)
  const go = useMobile((s) => s.go)
  const open = useMobile((s) => s.ownCode)
  const refusedPair = useMobile((s) => s.refusedPair)
  const [code, setCode] = useState<{ word: string; expiresAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const asked = useRef(false)
  const now = useNow(code !== null)

  const ask = useCallback(async () => {
    const group = groupRef.current?.group
    setError(null)
    if (!group) {
      setError(LEAVE_OFFLINE)
      return
    }
    setBusy(true)
    try {
      const res = await group.startPairing()
      if ('error' in res) setError(codeError(res))
      else setCode({ word: encodePairingCode(res.qr), expiresAt: res.expiresAt })
    } finally {
      setBusy(false)
    }
  }, [])

  // Once per visit, not again on StrictMode's second mount.
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void ask()
  }, [ask])

  // A device confirmed (or three wrong codes rejected it): the code is spent, whatever its clock says.
  const spent = code !== null && open?.expiresAt !== code.expiresAt
  const left = code ? ownCodeLeft(spent ? now : code.expiresAt, now) : null
  // Another phone redeemed it, and the group refused it: the code is spent, and says why.
  const refused = spent && refusedPair !== null

  const copy = async () => {
    if (!code) return
    if (await copyToClipboard(code.word)) {
      setCopied(true)
      setTimeout(() => setCopied(false), COPIED_MS)
    }
  }
  // The system share sheet where the WebView has one; Copy otherwise.
  const share = async () => {
    if (!code) return
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text: code.word })
        return
      } catch (err) {
        // Dismissed by the user: nothing more to do.
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    }
    await copy()
  }

  const header = (
    <div className="flex h-13 items-center gap-1 px-1.5">
      <button
        type="button"
        aria-label="Back"
        onClick={() => goBack()}
        className="grid h-11 w-11 place-items-center fs-28 leading-none text-ink-200/85"
      >
        ‹
      </button>
      <h1 className="flex-1 fs-17 font-bold">Add a device</h1>
    </div>
  )
  const footer = (
    <div className="px-4 pb-1.5 pt-2.5">
      <SecondaryButton onClick={() => go('pairing')}>Scan a code instead</SecondaryButton>
    </div>
  )

  return (
    <MobileScreen header={header} footer={footer}>
      <div className="flex flex-col gap-4 px-5 pt-6">
        <div className="font-mono fs-10 tracking-[0.2em] text-accent/85">THIS PHONE&apos;S CODE</div>
        <h2 className="fs-22 font-bold leading-[1.25] tracking-[-0.01em] [text-wrap:balance]">
          Paste it on the device you&apos;re adding
        </h2>
        {/* Canvas 50i: the QR payload as one long word, wrapping in a box at least 85 px tall. */}
        <div className="box-border h-fit min-h-[85px] select-all break-all rounded-[14px] border border-line/20 bg-shade/60 px-4 py-3.5 font-mono fs-13 leading-[1.55] text-ink-100">
          {refused ? (
            <span className="font-sans fs-14 break-normal text-ink-600/85">
              {refusedPair?.error === 'joining' ? REFUSED_JOINING : REFUSED_PHONE}
            </span>
          ) : code && !left?.expired ? (
            code.word
          ) : (
            ''
          )}
        </div>
        {left?.expired || (!code && error) ? (
          <PrimaryButton disabled={busy} onClick={() => void ask()}>
            New code
          </PrimaryButton>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            <SecondaryButton disabled={!code} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </SecondaryButton>
            <SecondaryButton disabled={!code} onClick={() => void share()}>
              Share…
            </SecondaryButton>
          </div>
        )}
        {error && (
          <p role="alert" className="fs-13 text-ink-600/85">
            {error}
          </p>
        )}
        <p className="fs-13.5 leading-[1.55] text-ink-600/85 [text-wrap:pretty]">
          On a desktop: Settings → Devices → <span className="font-semibold text-ink-100">Have another device&apos;s code?</span>{' '}
          {/* Canvas 50i (Device group) own-code sheet. */}
          On a server: <span className="font-mono fs-12">orbital join</span> and the code.
        </p>
        {left && !refused && (
          <div className="flex flex-col gap-[7px]">
            <div aria-hidden className="h-[3px] overflow-hidden rounded-full bg-line/12">
              <div
                className="h-full bg-accent/70 transition-[width] duration-1000 ease-linear"
                style={{ width: `${left.fraction * 100}%` }}
              />
            </div>
            <span className="font-mono fs-10.5 text-ink-900/60">{left.line}</span>
          </div>
        )}
        <p className="font-mono fs-10.5 leading-[1.6] text-ink-900/50">
          no QR here — nothing in the group scans one but a phone
        </p>
      </div>
    </MobileScreen>
  )
}
