import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { formatFingerprint } from '@orbital/shared/remote/keys'
import { PAIRING_TOKEN_TTL_MS } from '@orbital/shared/remote/relayApi'
import { useNow } from '../../lib/useNow'
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
  const [scanner, setScanner] = useState<'unknown' | 'ready' | 'unavailable'>('unknown')
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
    if (result.kind === 'unavailable') {
      setScanner('unavailable')
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

  const showPaste = scanner === 'unavailable' || __MOBILE_DEV__
  return (
    <Step
      label="STEP 1 OF 2"
      title="Pair with your Mac"
      body="On your Mac, open Settings → Mobile and show the pairing code. Scan it here."
    >
      {scanner !== 'unavailable' && <PrimaryButton onClick={() => void scan()}>Scan code</PrimaryButton>}
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
            autoFocus={scanner === 'unavailable' || __MOBILE_DEV__}
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

function Step({ label, title, body, children }: { label?: string; title: string; body?: string; children: ReactNode }) {
  return (
    <MobileScreen>
      <div className="flex flex-col gap-5 px-6 pt-16">
        <div>
          {label && <div className="font-mono text-[10.5px] tracking-[0.14em] text-text-muted">{label}</div>}
          <h1 className="mt-2 text-[22px] font-semibold">{title}</h1>
          {body && <p className="mt-2 text-[14px] text-text-soft">{body}</p>}
        </div>
        {children}
      </div>
    </MobileScreen>
  )
}

function Fingerprint({ value }: { value: string }) {
  return (
    <div className="flex items-center justify-center gap-3 font-mono text-[26px] tracking-[0.18em]">
      {[value.slice(0, 3), value.slice(3)].map((half, i) => (
        <span key={i} className="rounded-[10px] border border-panel-border px-4 py-3">
          {half}
        </span>
      ))}
    </div>
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
    <Step
      label="STEP 2 OF 2"
      title={`Confirm on ${step.macName}`}
      body="Your Mac shows the same six characters. Accept there if they match."
    >
      <Fingerprint value={step.fingerprint} />
      {/* Drains over PAIRING_TOKEN_TTL_MS, the code's whole life. */}
      <div aria-hidden className="h-[3px] overflow-hidden rounded-full bg-[rgba(150,205,255,.1)]">
        <div
          className="h-full bg-[rgba(89,228,243,.6)] transition-[width] duration-1000 ease-linear"
          style={{ width: `${(left / PAIRING_TOKEN_TTL_MS) * 100}%` }}
        />
      </div>
      <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
    </Step>
  )
}

function PairedStep({ step }: { step: Extract<PairingStep, { kind: 'paired' }> }) {
  return (
    <Step title={`Paired with ${step.macName}`}>
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
