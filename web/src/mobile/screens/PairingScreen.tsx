import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { formatFingerprint } from '@orbital/shared/remote/keys'
import { PAIRING_TOKEN_TTL_MS } from '@orbital/shared/remote/relayApi'
import { codeLeft } from '../../lib/remote'
import { useNow } from '../../lib/useNow'
import { useOrbital } from '../../store/store'
import { FingerprintBoxes } from '../../ui/FingerprintBoxes'
import { parseQrText } from '../pairingFlow'
import { runPairing, type PairingStep } from '../pairingRun'
import { identityIsDevOnly } from '../platform/identity'
import { scanQr } from '../platform/scanner'
import { useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { MobileScreen, PrimaryButton, SecondaryButton } from '../ui'

export const NOT_A_CODE = "That isn't an Orbital pairing code."

/** 9e (spec § 5): scan, confirm the fingerprint on the Mac, paired. */
export function PairingScreen() {
  const [step, setStep] = useState<PairingStep>({ kind: 'scan', error: null })
  // `installing`: Scan stays, with a note; `unsupported`: the paste field is the way in.
  const [scanner, setScanner] = useState<'unknown' | 'ready' | 'installing' | 'unsupported'>('unknown')
  const [pasted, setPasted] = useState('')
  const run = useRef(0)
  const opened = useRef(false)

  const start = useCallback((text: string) => {
    const qr = parseQrText(text)
    if (!qr) {
      setStep({ kind: 'scan', error: NOT_A_CODE })
      return
    }
    const id = ++run.current
    void runPairing(
      qr,
      (next) => {
        if (run.current === id) setStep(next)
      },
      () => run.current !== id,
    )
  }, [])

  const scan = useCallback(async () => {
    const result = await scanQr()
    if (result.kind === 'unsupported' || result.kind === 'installing') {
      setScanner(result.kind)
      return
    }
    setScanner('ready')
    if (result.kind === 'code') start(result.text)
  }, [start])

  // Step 1 opens the scanner at once (spec § 5) — once, not again on StrictMode's second mount.
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    void scan()
  }, [scan])

  // Leaving the screen any other way (the hardware back button) ends the run
  // as Cancel does — unless it already paired: the stored pairing owns that link.
  useEffect(
    () => () => {
      if (useMobile.getState().pairing) return
      run.current++
      clientRef.set(null)
    },
    [],
  )

  // Cancel closes the socket and returns to the previous screen, or stays here when there is none.
  const cancel = useCallback(() => {
    run.current++
    clientRef.set(null)
    if (useMobile.getState().goBack() === 'exit') setStep({ kind: 'scan', error: null })
  }, [])

  const scanAgain = useCallback(() => {
    run.current++
    clientRef.set(null)
    setStep({ kind: 'scan', error: null })
    void scan()
  }, [scan])

  if (step.kind === 'connecting') {
    return (
      <Step title="Connecting to the relay…" footer={<SecondaryButton onClick={cancel}>Cancel</SecondaryButton>}>
        {null}
      </Step>
    )
  }
  if (step.kind === 'confirm') return <ConfirmStep step={step} onCancel={cancel} />
  if (step.kind === 'paired') return <PairedStep step={step} />
  if (step.kind === 'expired') {
    return (
      <Step
        title="Code expired · scan again"
        footer={
          <div className="flex flex-col gap-3">
            <PrimaryButton onClick={scanAgain}>Scan again</PrimaryButton>
            <SecondaryButton onClick={cancel}>Cancel</SecondaryButton>
          </div>
        }
      >
        {null}
      </Step>
    )
  }

  const showPaste = scanner === 'unsupported' || __MOBILE_DEV__
  return (
    <Step label="STEP 1 OF 2" title="Scan the code on your Mac" footer={<SecondaryButton onClick={cancel}>Cancel</SecondaryButton>}>
      {/* 9e draws the camera here. The system scanner opens over the app instead, so this
          frame is where it comes back from: a tap opens it again. */}
      {scanner !== 'unsupported' && <ScanFrame onScan={() => void scan()} />}
      {scanner === 'installing' && (
        <p className="text-center text-[13px] text-[rgba(160,190,225,.65)]">Scanner is installing — try again in a moment</p>
      )}
      <p className="text-center text-[14px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
        On the Mac: Orbital → Settings → <span className="font-semibold text-text-bright">Mobile</span> → Pair a phone.
      </p>
      <p className="max-w-[270px] text-center font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.55)]">
        no account · the code carries the relay address and the Mac&apos;s public key
      </p>
      {showPaste && (
        <form
          className="flex w-full flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            start(pasted)
          }}
        >
          <label htmlFor="pairing-code" className="font-mono text-[10.5px] tracking-[0.14em] text-text-muted">
            OR PASTE THE CODE&apos;S TEXT
          </label>
          <textarea
            id="pairing-code"
            value={pasted}
            // Where a code arrives by typing (the emulator, mobile/scripts/pair-emulator.sh), it pairs as soon as it is whole.
            autoFocus={scanner === 'unsupported' || __MOBILE_DEV__}
            onChange={(event) => {
              setPasted(event.target.value)
              if (parseQrText(event.target.value)) start(event.target.value)
            }}
            rows={4}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="rounded-[10px] border border-panel-border bg-[rgba(4,8,16,.6)] p-3 font-mono text-[12px] text-text-soft"
          />
          <SecondaryButton type="submit" disabled={!pasted.trim()}>
            Pair
          </SecondaryButton>
        </form>
      )}
      {step.error && (
        <p role="alert" className="text-center text-[13px] text-[var(--state-interrupted)]">
          {step.error}
        </p>
      )}
      {identityIsDevOnly() && (
        <p className="font-mono text-[10.5px] text-text-muted">dev only · this browser keeps the phone&apos;s key unprotected</p>
      )}
    </Step>
  )
}

/** 9e's camera window: a striped square with four cyan corners. */
function ScanFrame({ onScan }: { onScan: () => void }) {
  const corner = 'absolute block h-9 w-9 border-[oklch(85%_.12_205)]'
  return (
    <button
      type="button"
      aria-label="Scan code"
      onClick={onScan}
      className="relative mt-1.5 grid aspect-square w-full max-w-[300px] place-items-center overflow-hidden rounded-[24px] bg-[#080c16] bg-[image:repeating-linear-gradient(135deg,rgba(150,205,255,.06)_0_8px,rgba(150,205,255,.015)_8px_16px)]"
    >
      <span className="font-mono text-[10px] tracking-[0.14em] text-[rgba(160,190,225,.5)]">TAP TO SCAN</span>
      <span aria-hidden className={`${corner} left-10 top-10 rounded-tl-[10px] border-l-[3px] border-t-[3px]`} />
      <span aria-hidden className={`${corner} right-10 top-10 rounded-tr-[10px] border-r-[3px] border-t-[3px]`} />
      <span aria-hidden className={`${corner} bottom-10 left-10 rounded-bl-[10px] border-b-[3px] border-l-[3px]`} />
      <span aria-hidden className={`${corner} bottom-10 right-10 rounded-br-[10px] border-b-[3px] border-r-[3px]`} />
    </button>
  )
}

/** One 9e screen: centred, the step in cyan over the title, the screen's action pinned at the bottom. */
function Step({
  label,
  title,
  body,
  mark,
  glow,
  footer,
  children,
}: {
  label?: string
  title: string
  body?: ReactNode
  mark?: ReactNode
  /** The cyan light behind the confirm and paired steps. */
  glow?: 'confirm' | 'paired'
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <MobileScreen footer={footer && <div className="px-4 pb-1.5 pt-2.5">{footer}</div>}>
      {glow && (
        <div
          aria-hidden
          className={[
            'pointer-events-none absolute inset-0',
            glow === 'paired'
              ? 'bg-[radial-gradient(ellipse_320px_280px_at_50%_30%,oklch(85%_.12_205/.09),transparent)]'
              : 'bg-[radial-gradient(ellipse_300px_260px_at_50%_38%,oklch(85%_.12_205/.07),transparent)]',
          ].join(' ')}
        />
      )}
      <div className={['relative flex flex-col items-center gap-[18px] px-7', mark ? 'pt-24' : 'pt-7'].join(' ')}>
        {mark}
        {label && <div className="font-mono text-[10px] tracking-[0.2em] text-[oklch(85%_.12_205/.85)]">{label}</div>}
        <h1 className={['text-center text-[24px] font-bold tracking-[-0.01em]', mark ? 'mt-2' : ''].join(' ')}>{title}</h1>
        {body && <p className="text-center text-[14px] leading-[1.55] text-[rgba(200,214,235,.85)]">{body}</p>}
        {children}
      </div>
    </MobileScreen>
  )
}

function ConfirmStep({
  step,
  onCancel,
}: {
  step: Extract<PairingStep, { kind: 'confirm' }>
  onCancel: () => void
}) {
  const now = useNow(true)
  const left = Math.max(0, step.expiresAt - now)
  return (
    <Step label="STEP 2 OF 2" title="Confirm on your Mac" glow="confirm" footer={<SecondaryButton onClick={onCancel}>Cancel pairing</SecondaryButton>}>
      <div className="flex max-w-full items-center gap-2.5 rounded-[12px] border border-[rgba(150,205,255,.14)] bg-[rgba(10,16,28,.7)] px-3.5 py-2.5 font-mono text-[12px] text-[rgba(200,220,245,.8)]">
        <span aria-hidden className="block h-[7px] w-[7px] shrink-0 rounded-full bg-[oklch(85%_.12_205)]" />
        <span className="truncate">{step.macName}</span>
        <span className="shrink-0 text-[rgba(160,190,225,.5)]">· reached via relay</span>
      </div>
      <div className="mt-[22px]">
        <FingerprintBoxes value={step.fingerprint} />
      </div>
      <p className="max-w-[300px] text-center text-[14px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
        Check the Mac shows the same six characters, then click <span className="font-semibold text-text-bright">Confirm</span> there. Nothing
        to do on the phone.
      </p>
      <div className="mt-3.5 flex w-60 flex-col items-center gap-2">
        {/* Drains over PAIRING_TOKEN_TTL_MS, the code's whole life. */}
        <div aria-hidden className="h-[3px] w-full overflow-hidden rounded-full bg-[rgba(150,205,255,.12)]">
          <div
            className="h-full bg-[oklch(85%_.12_205/.7)] transition-[width] duration-1000 ease-linear"
            style={{ width: `${(left / PAIRING_TOKEN_TTL_MS) * 100}%` }}
          />
        </div>
        <p className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">waiting · code expires in {codeLeft(step.expiresAt, now).label}</p>
      </div>
    </Step>
  )
}

function PairedStep({ step }: { step: Extract<PairingStep, { kind: 'paired' }> }) {
  const listed = useMobile((s) => s.listedAt !== null)
  const live = useOrbital((s) => Object.values(s.sessions).filter((x) => x.status !== 'ended').length)
  // Only once the Mac's list has been read: before that the count would be a guess.
  const waiting = listed ? (live === 1 ? '1 live session is waiting.' : `${live} live sessions are waiting.`) : undefined
  return (
    <Step
      title={`Paired with ${step.macName}`}
      body={waiting}
      mark={<PairedMark />}
      glow="paired"
      footer={<PrimaryButton onClick={() => useMobile.getState().go('list')}>Open sessions</PrimaryButton>}
    >
      <dl className="mt-3.5 flex w-full flex-col rounded-[14px] border border-[rgba(150,205,255,.12)] bg-[rgba(10,16,28,.6)] font-mono text-[11.5px] text-[rgba(160,190,225,.65)]">
        {[
          ['relay', step.relayHost],
          ['encryption', 'end-to-end'],
          ['fingerprint', formatFingerprint(step.fingerprint)],
        ].map(([term, value], i) => (
          <div key={term} className={['flex gap-3 px-3.5 py-3', i > 0 ? 'border-t border-[rgba(150,205,255,.08)]' : ''].join(' ')}>
            <dt>{term}</dt>
            <dd className="ml-auto min-w-0 truncate text-text-bright">{value}</dd>
          </div>
        ))}
      </dl>
    </Step>
  )
}

/** 9e paired: the mark's ring, lit, with the check inside and its moon on the rim. */
function PairedMark() {
  return (
    <span
      aria-hidden
      className="relative grid h-[72px] w-[72px] place-items-center rounded-full border-2 border-[oklch(85%_.12_205)] text-[26px] text-[oklch(85%_.12_205)] shadow-[0_0_30px_oklch(85%_.12_205/.4)]"
    >
      ✓
      <span className="absolute right-0.5 top-0.5 block h-3.5 w-3.5 rounded-full bg-[oklch(85%_.12_205)] shadow-[0_0_12px_oklch(85%_.12_205)]" />
    </span>
  )
}
