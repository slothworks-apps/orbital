import { useEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { codeLeft } from '../lib/remote'
import { useNow } from '../lib/useNow'
import type { RemoteStatus } from '../lib/types'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { PAIRING_CODE_LENGTH, PairingCodeInput } from '../ui/PairingCodeInput'

type PendingPair = NonNullable<RemoteStatus['pendingPair']>

/**
 * A phone asking to pair (spec 2026-10-01-settings-mobile-design § 4; canvas
 * 9o). The app's, not the Settings dialog's: up whenever the status carries
 * `pendingPair`, wherever the user is. It closes when the status stops
 * carrying the request, never on its own clock, and nothing in it accepts on
 * its own.
 *
 * The user types the code the phone shows and the server compares it (spec
 * 2026-10-06-pairing-code-and-app-lock-design § 1): only the phone that sent
 * this request shows the code it expects.
 */
export function PairConfirmDialog() {
  const remote = useOrbital((s) => s.remote)
  const pending = remote?.pendingPair ?? null
  const pairing = remote?.pairing ?? null
  // The request stays drawn through the close transition after the status drops it.
  const shown = useRef<PendingPair | null>(null)
  if (pending) shown.current = pending
  const request = pending ?? shown.current

  const now = useNow(pending !== null)
  const [busy, setBusy] = useState(false)
  const [relayFailed, setRelayFailed] = useState(false)
  const [code, setCode] = useState('')
  /** Set by a wrong code: how many more the server takes before it rejects. */
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null)
  const complete = code.length === PAIRING_CODE_LENGTH

  // A different request (or none) starts empty, without the last one's failure.
  useEffect(() => {
    setRelayFailed(false)
    setCode('')
    setAttemptsLeft(null)
  }, [pending?.phone])

  // The server publishes nothing when the code runs out; it clears the request
  // inside its next `status()`. So at zero the dialog asks, and closes from the
  // answer — never on its own clock. One read at a time, and asked again only
  // while the server's answer is still missing: on each status that lands
  // meanwhile (it may have superseded the answer in flight) and once more when
  // an answer was dropped for a newer status. Never on the store's own answer,
  // so this is no polling loop.
  const timedOut = pending !== null && pairing !== null && codeLeft(pairing.expiresAt, now).expired
  const reading = useRef(false)
  const answered = useRef<RemoteStatus | null>(null)
  const [superseded, setSuperseded] = useState(0)
  useEffect(() => {
    if (!timedOut || reading.current || remote === answered.current) return
    reading.current = true
    void useOrbital.getState().refreshRemote().then((outcome) => {
      reading.current = false
      if (outcome === 'stored') answered.current = useOrbital.getState().remote
      else if (outcome === 'superseded') setSuperseded((n) => n + 1)
    })
  }, [timedOut, remote, superseded])

  async function answer(accept: boolean) {
    if (!pending || busy || (accept && !complete)) return
    const { phone, name } = pending
    setBusy(true)
    setRelayFailed(false)
    try {
      const res = accept ? await api.confirmPairing(true, phone, code) : await api.confirmPairing(false, phone)
      if ('ok' in res) {
        useOrbital.setState({ toast: { kind: 'info', message: accept ? `Paired with ${name}` : 'Request rejected' } })
      } else if (res.error === 'relay_error') {
        setRelayFailed(true)
      } else if (res.error === 'code_mismatch') {
        // Canvas 9o C: the boxes clear and one quiet line counts what is left.
        setCode('')
        setAttemptsLeft(res.attemptsLeft)
      } else if (res.error === 'code_rejected') {
        // The server rejected the request and publishes it gone, which closes the dialog.
        useOrbital.setState({ toast: { kind: 'info', message: 'Request rejected · three codes didn’t match' } })
      } else {
        // `no_pending` / `mismatch`: what the dialog shows is stale. No publish
        // may follow (an expired request is cleared silently), so the status
        // is read back; the dialog closes or redraws from the store.
        void useOrbital.getState().refreshRemote()
      }
    } catch (err) {
      reportError(err, 'Failed to answer the pairing request')
    } finally {
      setBusy(false)
    }
  }

  const eyebrow = pairing
    ? `PAIRING REQUEST · EXPIRES IN ${codeLeft(pairing.expiresAt, now).label}`
    : 'PAIRING REQUEST'

  return (
    <Dialog
      open={pending !== null}
      variant="card"
      eyebrow={eyebrow}
      title="A phone wants to pair"
      // Esc is a rejection, never a dismissal that leaves the request hanging.
      onClose={() => void answer(false)}
    >
      {request && (
        <>
          {/* Canvas 9o: the device in a hairline chip, name bright, the rest muted. */}
          <div className="flex items-center gap-2 rounded-[10px] border border-[rgba(150,205,255,.14)] bg-[rgba(4,8,16,.6)] px-3 py-2 font-mono text-xs text-text-bright">
            {request.name}
            <span className="text-[rgba(160,190,225,.55)]">· {request.platform} · via relay</span>
          </div>
          <p className="text-[13.5px] leading-[1.55] text-[rgba(200,214,235,.88)]">Type the code shown on the phone.</p>
          {/* Never disabled while an answer is in flight: that would drop the
              focus, and after a wrong code the user types straight on. */}
          <PairingCodeInput value={code} onChange={setCode} onSubmit={() => void answer(true)} autoFocus />
          <div className="min-h-[18px] font-mono text-[11px] text-[rgba(160,190,225,.7)]">
            {relayFailed
              ? "The relay didn't answer. Try again."
              : attemptsLeft !== null &&
                `That code didn’t match · ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left`}
          </div>
          <div className="flex w-full gap-2.5">
            <Button variant="ghost" size="wide" disabled={busy} onClick={() => void answer(false)}>
              Reject
            </Button>
            <Button variant="primary" size="wide" disabled={busy || !complete} onClick={() => void answer(true)}>
              Accept
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
