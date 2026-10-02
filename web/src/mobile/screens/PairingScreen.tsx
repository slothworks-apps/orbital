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
import { MobileMark, MobileScreen, PrimaryButton, SecondaryButton } from '../ui'

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
      <Step title="Connecting to the relay…">
        <SecondaryButton onClick={cancel}>Cancel</SecondaryButton>
      </Step>
    )
  }
  if (step.kind === 'confirm') return <ConfirmStep step={step} onCancel={cancel} />
  if (step.kind === 'paired') return <PairedStep step={step} />
  if (step.kind === 'expired') {
    return (
      <Step title="Code expired · scan again">
        <PrimaryButton onClick={scanAgain}>Scan again</PrimaryButton>
        <SecondaryButton onClick={cancel}>Cancel</SecondaryButton>
      </Step>
    )
  }

  const showPaste = scanner === 'unsupported' || __MOBILE_DEV__
  return (
    <Step label="STEP 1 OF 2" title="Scan the code on your Mac" body="On the Mac: Orbital → Settings → Mobile → Pair a phone.">
      <p className="font-mono text-[10.5px] leading-[1.5] text-text-muted">
        no account · the code carries the relay address and the Mac&apos;s public key
      </p>
      {scanner !== 'unsupported' && <PrimaryButton onClick={() => void scan()}>Scan code</PrimaryButton>}
      {scanner === 'installing' && (
        <p className="text-[13px] text-text-muted">Scanner is installing — try again in a moment</p>
      )}
      {showPaste && (
        <form
          className="flex flex-col gap-2"
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
        <p role="alert" className="text-[13px] text-[var(--state-interrupted)]">
          {step.error}
        </p>
      )}
      {identityIsDevOnly() && (
        <p className="font-mono text-[10.5px] text-text-muted">dev only · this browser keeps the phone&apos;s key unprotected</p>
      )}
    </Step>
  )
}

function Step({
  label,
  title,
  body,
  mark,
  children,
}: {
  label?: string
  title: string
  body?: ReactNode
  mark?: ReactNode
  children: ReactNode
}) {
  return (
    <MobileScreen>
      <div className="flex flex-col gap-5 px-6 pt-16">
        <div>
          {mark && <div className="mb-5">{mark}</div>}
          {label && <div className="font-mono text-[10.5px] tracking-[0.14em] text-text-muted">{label}</div>}
          <h1 className="mt-2 text-[22px] font-semibold">{title}</h1>
          {body && <p className="mt-2 text-[14px] text-text-soft">{body}</p>}
        </div>
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
    <Step label="STEP 2 OF 2" title="Confirm on your Mac">
      <div className="-mt-3 flex items-center gap-2 font-mono text-[11.5px] text-text-muted">
        <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <span className="truncate">{step.macName} · reached via relay</span>
      </div>
      <FingerprintBoxes value={step.fingerprint} />
      <p className="text-[14px] text-text-soft">
        Check the Mac shows the same six characters, then click Confirm there. Nothing to do on the phone.
      </p>
      <div>
        {/* Drains over PAIRING_TOKEN_TTL_MS, the code's whole life. */}
        <div aria-hidden className="h-[3px] overflow-hidden rounded-full bg-[rgba(150,205,255,.1)]">
          <div
            className="h-full bg-[rgba(89,228,243,.6)] transition-[width] duration-1000 ease-linear"
            style={{ width: `${(left / PAIRING_TOKEN_TTL_MS) * 100}%` }}
          />
        </div>
        <p className="mt-2 font-mono text-[11px] text-text-muted">
          waiting · code expires in {codeLeft(step.expiresAt, now).label}
        </p>
      </div>
      <SecondaryButton onClick={onCancel}>Cancel pairing</SecondaryButton>
    </Step>
  )
}

function PairedStep({ step }: { step: Extract<PairingStep, { kind: 'paired' }> }) {
  const listed = useMobile((s) => s.listedAt !== null)
  const live = useOrbital((s) => Object.values(s.sessions).filter((x) => x.status !== 'ended').length)
  // Only once the Mac's list has been read: before that the count would be a guess.
  const waiting = listed ? (live === 1 ? '1 live session is waiting.' : `${live} live sessions are waiting.`) : undefined
  return (
    <Step title={`Paired with ${step.macName}`} body={waiting} mark={<MobileMark checked />}>
      <dl className="flex flex-col gap-2 font-mono text-[12px] text-text-muted">
        <div className="flex justify-between">
          <dt>relay</dt>
          <dd className="text-text-soft">{step.relayHost}</dd>
        </div>
        <div className="flex justify-between">
          <dt>encryption</dt>
          <dd className="text-text-soft">end-to-end</dd>
        </div>
        <div className="flex justify-between">
          <dt>fingerprint</dt>
          <dd className="text-text-soft">{formatFingerprint(step.fingerprint)}</dd>
        </div>
      </dl>
      <PrimaryButton onClick={() => useMobile.getState().go('list')}>Open sessions</PrimaryButton>
    </Step>
  )
}
