import { useEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { codeLeft } from '../lib/remote'
import { attemptsLine, joinSentence, kindTile, whereLine } from '../lib/joinRequest'
import { useNow } from '../lib/useNow'
import type { RemoteStatus } from '../lib/types'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { KindGlyph } from '../ui/KindGlyph'
import { PAIRING_CODE_LENGTH, PairingCodeInput } from '../ui/PairingCodeInput'

type PendingPair = NonNullable<RemoteStatus['pendingPair']>

/**
 * A device asking to join through this one (spec
 * 2026-10-16-device-group-design § 3, canvas 50c). Up whenever the status
 * carries `pendingPair`, wherever the user is. It closes when the status
 * stops carrying the request, never on its own clock, and nothing in it
 * accepts on its own. Names the device's kind three times — the tile, its
 * word, and the sentence — so a server can't be mistaken for a phone (canvas
 * 50c "KIND, THREE TIMES").
 *
 * The user types the code the joining device shows and the server compares
 * it (spec 2026-10-06-pairing-code-and-app-lock-design § 1): only the device
 * that sent this request shows the code it expects.
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
  /** Set by Accept's success: the joined screen (canvas 50c `cDone`) replaces the code form until a new request. */
  const [joined, setJoined] = useState<{ name: string } | null>(null)
  const complete = code.length === PAIRING_CODE_LENGTH

  // A different request (or none) starts empty, without the last one's failure.
  useEffect(() => {
    setRelayFailed(false)
    setCode('')
    setAttemptsLeft(null)
  }, [pending?.phone])

  // A new request replaces a stale joined screen; our own success clears
  // `pending` too, and must not wipe the screen it just set — so this keys
  // on the request's identity, not its every field.
  useEffect(() => {
    if (pending) setJoined(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // Accept gets its own screen (canvas 50c `cDone`); Reject keeps the toast.
        if (accept) setJoined({ name })
        else useOrbital.setState({ toast: { kind: 'info', message: 'Request rejected' } })
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
    ? `JOIN REQUEST · EXPIRES IN ${codeLeft(pairing.expiresAt, now).label}`
    : 'JOIN REQUEST'

  // The sentence names the kind a second time (`joinSentence`).
  const sentence = request ? joinSentence(request) : ''
  const tile = request ? kindTile(request.kind) : null
  // Canvas 50c "KIND, THREE TIMES": the glyph at 3×, the kind word, its
  // meaning — above the sentence (the dialog's title), which names the kind
  // again. `cDone`'s checkmark takes the same slot above "<name> joined".
  const kindTileNode =
    request && tile ? (
      <div className="flex w-full items-center gap-4 rounded-xl border border-[rgba(150,205,255,.26)] bg-[rgba(4,8,16,.6)] px-[18px] py-3.5 text-left">
        <span className="grid h-[60px] w-[60px] shrink-0 place-items-center rounded-xl border border-[rgba(150,205,255,.2)] text-text-bright">
          <KindGlyph kind={request.kind} scale={3} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className="font-mono text-base tracking-[0.2em] text-text-bright">{tile.word}</span>
          <span className="text-[12.5px] leading-[1.45] text-[rgba(160,190,225,.78)]">{tile.note}</span>
        </span>
      </div>
    ) : null

  return (
    <Dialog
      open={pending !== null || joined !== null}
      variant="card"
      eyebrow={joined ? undefined : eyebrow}
      beforeTitle={
        joined ? (
          <span
            aria-hidden
            className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full border-2 border-accent text-xl text-accent"
          >
            ✓
          </span>
        ) : (
          kindTileNode
        )
      }
      title={joined ? `${joined.name} joined` : sentence}
      // Esc is a rejection while a request is open; the joined screen has
      // nothing left to reject, so it only dismisses.
      onClose={() => (joined ? setJoined(null) : void answer(false))}
    >
      {joined ? (
        <>
          <p className="text-[13px] leading-[1.55] text-[rgba(160,190,225,.72)] [text-wrap:pretty]">
            The other devices link to it on their own. It appears under Devices → In this group.
          </p>
          {/* No canvas 50c button (its only control is the demo's RESET DEMO);
              styled as the pending state's primary action, as 50i's phone
              sheet has its own "Done". */}
          {/* In a row like Accept and Reject: `wide` grows along the row, and as a
              child of the dialog's column it would collapse to its text's height. */}
          <div className="flex w-full">
            <Button variant="primary" size="wide" onClick={() => setJoined(null)}>
              Done
            </Button>
          </div>
        </>
      ) : (
        request &&
        tile && (
          <>
            <p className="text-[13px] leading-[1.55] text-[rgba(200,214,235,.82)] [text-wrap:pretty]">
              Once in, it sees and drives every session on every device in this group.
            </p>
            <p className="text-[13.5px] leading-[1.55] text-text-bright">{whereLine(request.kind, request.name)}</p>
            {/* Never disabled while an answer is in flight: that would drop the
                focus, and after a wrong code the user types straight on. */}
            <PairingCodeInput value={code} onChange={setCode} onSubmit={() => void answer(true)} autoFocus />
            <div className="min-h-[18px] font-mono text-[11px] text-[rgba(160,190,225,.7)]">
              {relayFailed
                ? "The relay didn't answer. Try again."
                : attemptsLeft !== null && attemptsLine(attemptsLeft)}
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
        )
      )}
    </Dialog>
  )
}
