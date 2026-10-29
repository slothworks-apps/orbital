import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { formatFingerprint } from '@orbital/shared/remote/keys'
import { codeLeft } from '../../lib/remote'
import { useNow } from '../../lib/useNow'
import { useOrbital } from '../../store/store'
import { kindOs } from '../../lib/devices'
import { FingerprintBoxes } from '../../ui/FingerprintBoxes'
import { KindGlyph } from '../../ui/KindGlyph'
import { parseQrText } from '../pairingFlow'
import { cancelPairing, runPairing, type ErrorCard, type PairingStep } from '../pairingRun'
import { identityIsDevOnly } from '../platform/identity'
import { scanQr } from '../platform/scanner'
import { useMobile } from '../state'
import { LitMark, MobileScreen, PrimaryButton, SecondaryButton } from '../ui'

export const NOT_A_CODE = "That isn't an Orbital pairing code."

/** 9e (spec § 5, canvas 50i): scan a desktop's code, type the phone's code on that device, paired. */
export function PairingScreen() {
  const [step, setStep] = useState<PairingStep>({ kind: 'scan', error: null })
  // `installing`: Scan stays, with a note; `unsupported`: the paste field is the way in.
  const [scanner, setScanner] = useState<'unknown' | 'ready' | 'installing' | 'unsupported'>('unknown')
  const [pasted, setPasted] = useState('')
  const run = useRef(0)
  const opened = useRef(false)
  /** The code last started, for Try again on a device that was offline (50d C). */
  const lastCode = useRef<string | null>(null)

  const start = useCallback((text: string) => {
    lastCode.current = text
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
  // as Cancel does. A phone in a group (or one that just joined) keeps its
  // group: `cancelPairing` only stops a join still waiting.
  useEffect(
    () => () => {
      run.current++
      cancelPairing()
    },
    [],
  )

  // Cancel closes the socket and returns to the previous screen, or stays here when there is none.
  const cancel = useCallback(() => {
    run.current++
    cancelPairing()
    if (useMobile.getState().goBack() === 'exit') setStep({ kind: 'scan', error: null })
  }, [])

  const scanAgain = useCallback(() => {
    run.current++
    cancelPairing()
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
  if (step.kind === 'offline') {
    return (
      <OfflineStep
        step={step}
        onTryAgain={() => {
          if (lastCode.current) start(lastCode.current)
        }}
        onScanAgain={scanAgain}
        onCancel={cancel}
      />
    )
  }
  if (step.kind === 'expired') {
    // Canvas 50d D; a device that said no reads as the desktop's rejected card.
    const card: ErrorCard = step.rejected
      ? { title: 'Request rejected', body: `${step.name} didn't let this phone in. Make a new code on ${step.name} and scan it again.` }
      : { title: 'Code expired', body: `Codes last two minutes. Make a new one on ${step.name} and scan it again.` }
    return (
      <Step
        title={card.title}
        footer={
          <div className="flex flex-col gap-3">
            <ErrorCardView error={card.body} />
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
    <Step
      label="STEP 1 OF 2"
      title="Scan the code on a desktop"
      footer={
        // Canvas 50i: a refusal is a card above Cancel, in 50d's words.
        <div className="flex flex-col gap-3">
          {step.error && <ErrorCardView error={step.error} />}
          <SecondaryButton onClick={cancel}>Cancel</SecondaryButton>
        </div>
      }
    >
      {/* 9e draws the camera here. The system scanner opens over the app instead, so this
          frame is where it comes back from: a tap opens it again. */}
      {scanner !== 'unsupported' && <ScanFrame onScan={() => void scan()} />}
      {scanner === 'installing' && (
        <p className="text-center fs-13 text-ink-900/65">Scanner is installing — try again in a moment</p>
      )}
      <p className="text-center fs-14 leading-[1.55] text-ink-600/85 [text-wrap:pretty]">
        On a desktop: Orbital → Settings → <span className="font-semibold text-ink-100">Devices</span>.
      </p>
      <p className="max-w-[270px] text-center font-mono fs-10.5 leading-[1.6] text-ink-900/55">
        an older Orbital shows it under Settings → Mobile · no account · the code carries the relay address and the
        device&apos;s public key
      </p>
      {showPaste && (
        <form
          className="flex w-full flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            start(pasted)
          }}
        >
          <label htmlFor="pairing-code" className="font-mono fs-10.5 tracking-[0.14em] text-ink-900/70">
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
            className="rounded-[10px] border border-line/14 bg-shade/60 p-3 font-mono fs-12 text-ink-300"
          />
          <SecondaryButton type="submit" disabled={!pasted.trim()}>
            Pair
          </SecondaryButton>
        </form>
      )}
      {identityIsDevOnly() && (
        <p className="font-mono fs-10.5 text-ink-900/70">dev only · this browser keeps the phone&apos;s key unprotected</p>
      )}
    </Step>
  )
}

/** 9e's camera window: a striped square with four cyan corners. */
function ScanFrame({ onScan }: { onScan: () => void }) {
  const corner = 'absolute block h-9 w-9 border-accent'
  return (
    <button
      type="button"
      aria-label="Scan code"
      onClick={onScan}
      className="relative mt-1.5 grid aspect-square w-full max-w-[300px] place-items-center overflow-hidden rounded-[24px] bg-space-deep bg-[image:repeating-linear-gradient(135deg,color-mix(in_oklab,_var(--color-line)_6%,_transparent)_0_8px,color-mix(in_oklab,_var(--color-line)_1.5%,_transparent)_8px_16px)]"
    >
      <span className="font-mono fs-10 tracking-[0.14em] text-ink-900/50">TAP TO SCAN</span>
      <span aria-hidden className={`${corner} left-10 top-10 rounded-tl-[10px] border-l-[3px] border-t-[3px]`} />
      <span aria-hidden className={`${corner} right-10 top-10 rounded-tr-[10px] border-r-[3px] border-t-[3px]`} />
      <span aria-hidden className={`${corner} bottom-10 left-10 rounded-bl-[10px] border-b-[3px] border-l-[3px]`} />
      <span aria-hidden className={`${corner} bottom-10 right-10 rounded-br-[10px] border-b-[3px] border-r-[3px]`} />
    </button>
  )
}

/**
 * The device that showed the code is not on the relay (canvas 50d C): its
 * code stays good while it lasts, and Try again redeems it once more. Once
 * it runs out, 50d D's words and Scan again.
 */
function OfflineStep({
  step,
  onTryAgain,
  onScanAgain,
  onCancel,
}: {
  step: Extract<PairingStep, { kind: 'offline' }>
  onTryAgain: () => void
  onScanAgain: () => void
  onCancel: () => void
}) {
  const now = useNow(step.expiresAt !== null)
  const left = step.expiresAt !== null ? codeLeft(step.expiresAt, now) : null
  const expired = left?.expired ?? false
  const body = expired
    ? `Codes last two minutes. Make a new one on ${step.name} and scan it again.`
    : left
      ? `Its code is good for another ${left.label} — try again once ${step.name} is online.`
      : `Try again once ${step.name} is online.`
  return (
    <Step
      title={expired ? 'Code expired' : `${step.name} is offline`}
      footer={
        <div className="flex flex-col gap-3">
          <ErrorCardView error={body} />
          {expired ? (
            <PrimaryButton onClick={onScanAgain}>Scan again</PrimaryButton>
          ) : (
            <PrimaryButton onClick={onTryAgain}>Try again</PrimaryButton>
          )}
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
        </div>
      }
    >
      {null}
    </Step>
  )
}

/** A refusal above Cancel (canvas 50i): a 50d card, or its body alone when it is one line. */
function ErrorCardView({ error }: { error: string | ErrorCard }) {
  const card = typeof error === 'string' ? { title: null, body: error } : error
  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-[14px] border border-line/14 bg-panel/70 px-3.5 py-3 text-left"
    >
      {card.title && <span className="fs-14 font-semibold text-ink-100">{card.title}</span>}
      <span className="fs-13 leading-[1.5] text-ink-600/85 [text-wrap:pretty]">{card.body}</span>
    </div>
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
        {label && <div className="font-mono fs-10 tracking-[0.2em] text-[oklch(85%_.12_205/.85)]">{label}</div>}
        <h1 className={['text-center fs-24 font-bold tracking-[-0.01em]', mark ? 'mt-2' : ''].join(' ')}>{title}</h1>
        {body && <p className="text-center fs-14 leading-[1.55] text-ink-600/85">{body}</p>}
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
  return (
    <Step
      label="STEP 2 OF 2"
      title={`Type ${formatFingerprint(step.fingerprint)} on ${step.macName}`}
      glow="confirm"
      footer={<SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>}
    >
      {/* Canvas 50i: the device by its glyph, name, kind and (once known) OS. The code carries no OS. */}
      <div className="flex max-w-full items-center gap-2.5 rounded-[12px] border border-line/14 bg-panel/70 px-3.5 py-2.5 font-mono fs-12 text-ink-500/85">
        <KindGlyph kind={step.deviceKind} untitled />
        <span className="truncate">{step.macName}</span>
        <span className="shrink-0 text-ink-900/50">· {kindOs(step.deviceKind, '')}</span>
      </div>
      <div className="mt-[22px]">
        <FingerprintBoxes value={step.fingerprint} />
      </div>
      {/* The device asks for the code (spec 2026-10-06-pairing-code-and-app-lock-design § 1). */}
      <p className="max-w-[300px] text-center fs-14 leading-[1.55] text-ink-600/85 [text-wrap:pretty]">
        {step.macName} is asking for these six characters now.
      </p>
      {/* No clock while the user types (canvas 50i): a code that runs out gets its own card. */}
      <p className="mt-3.5 font-mono fs-10.5 text-ink-900/60">waiting for {step.macName}</p>
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
      mark={<LitMark variant="paired" />}
      glow="paired"
      footer={<PrimaryButton onClick={() => useMobile.getState().go('list')}>Open sessions</PrimaryButton>}
    >
      <dl className="mt-3.5 flex w-full flex-col rounded-[14px] border border-line/12 bg-panel/60 font-mono fs-11.5 text-ink-900/65">
        {[
          ['relay', step.relayHost],
          ['encryption', 'end-to-end'],
          ['fingerprint', formatFingerprint(step.fingerprint)],
        ].map(([term, value], i) => (
          <div key={term} className={['flex gap-3 px-3.5 py-3', i > 0 ? 'border-t border-line/8' : ''].join(' ')}>
            <dt>{term}</dt>
            <dd className="ml-auto min-w-0 truncate text-ink-100">{value}</dd>
          </div>
        ))}
      </dl>
    </Step>
  )
}
