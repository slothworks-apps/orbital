import { useEffect, useRef, useState } from 'react'
import { osName } from '@orbital/shared/remote/device'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { codeLeft } from '../lib/remote'
import { openSettingsSection } from '../lib/sessionUrl'
import { kindTile, whereLine } from '../lib/joinRequest'
import {
  CODE_REJECTED, GROUP_FULL, JOIN_REACH, REQUEST_REJECTED, attemptsLine, groupFullBody, joinSentence, managerWords, osLabel,
} from '@orbital/shared/remote/groupWords'
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
  const [joined, setJoined] = useState<{ name: string; done: string | null } | null>(null)
  /** Set by an Accept the group had no room for: canvas 50o replaces the code form until a new request. */
  const [full, setFull] = useState<PendingPair | null>(null)
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
    if (pending) {
      setJoined(null)
      setFull(null)
    }
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
    const { done } = managerWords(pending.manager, name)
    setBusy(true)
    setRelayFailed(false)
    try {
      const res = accept ? await api.confirmPairing(true, phone, code) : await api.confirmPairing(false, phone)
      if ('ok' in res) {
        // Accept gets its own screen (canvas 50c `cDone`); Reject keeps the toast.
        if (accept) setJoined({ name, done })
        else useOrbital.setState({ toast: { kind: 'info', message: REQUEST_REJECTED } })
      } else if (res.error === 'relay_error') {
        setRelayFailed(true)
      } else if (res.error === 'code_mismatch') {
        // Canvas 9o C: the boxes clear and one quiet line counts what is left.
        setCode('')
        setAttemptsLeft(res.attemptsLeft)
      } else if (res.error === 'code_rejected') {
        // The server rejected the request and publishes it gone, which closes the dialog.
        useOrbital.setState({ toast: { kind: 'info', message: CODE_REJECTED } })
      } else if (res.error === 'group_full') {
        // The server rejected the request and publishes it gone; the answer takes the dialog's place (canvas 50o).
        setFull(pending)
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

  // No clock while the user types (canvas 50c `cHead`): the header says only whether the group is new.
  const manager = request ? managerWords(request.manager, request.name) : null
  const eyebrow = manager?.eyebrow ?? 'JOIN REQUEST'

  // The sentence names the kind a second time (`joinSentence`).
  const sentence = request ? joinSentence(request) : ''
  const tile = request ? kindTile(request.kind) : null
  // Canvas 50c "KIND, THREE TIMES": the glyph at 3×, the kind word, its
  // meaning — above the sentence (the dialog's title), which names the kind
  // again. `cDone`'s checkmark takes the same slot above "<name> joined".
  const kindTileNode =
    request && tile ? (
      <div className="flex w-full items-center gap-4 rounded-xl border border-line/26 bg-space/60 px-[18px] py-3.5 text-left">
        <span className="grid h-[60px] w-[60px] shrink-0 place-items-center rounded-xl border border-line/20 text-ink-100">
          <KindGlyph kind={request.kind} scale={3} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className="font-mono fs-16 leading-(--text-base--line-height) tracking-[0.2em] text-ink-100">{tile.word}</span>
          <span className="fs-12.5 leading-[1.45] text-ink-900/78">{tile.note}</span>
        </span>
      </div>
    ) : null

  return (
    <Dialog
      open={pending !== null || joined !== null || full !== null}
      variant="card"
      eyebrow={full ? 'JOIN REQUEST · NOT ADDED' : joined ? undefined : eyebrow}
      beforeTitle={
        full ? (
          <FullTile request={full} />
        ) : joined ? (
          <span
            aria-hidden
            className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full border-2 border-accent fs-20 leading-(--text-xl--line-height) text-accent"
          >
            ✓
          </span>
        ) : (
          kindTileNode
        )
      }
      title={full ? GROUP_FULL : joined ? `${joined.name} joined` : sentence}
      // Esc is a rejection while a request is open; the joined and full
      // screens have nothing left to reject, so they only dismiss.
      onClose={() => (full ? setFull(null) : joined ? setJoined(null) : void answer(false))}
    >
      {full ? (
        <FullBody name={full.name} onClose={() => setFull(null)} />
      ) : joined ? (
        <>
          <p className="fs-13 leading-[1.55] text-ink-900/72 [text-wrap:pretty]">
            {joined.done ?? 'The other devices link to it on their own. It appears under Devices → In this group.'}
          </p>
          {/* Not on the canvas: 50c draws no Done (its only control is the
              demo's RESET DEMO); styled as the pending state's primary action,
              as 50i's phone sheet has its own "Done". */}
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
            <p className="fs-13 leading-[1.55] text-ink-600/82 [text-wrap:pretty]">
              {JOIN_REACH}
            </p>
            {/* Canvas 50c `cFirst`: the role is permanent, so the pairing that sets it says so. */}
            {manager?.line && (
              <p className="box-border w-full rounded-[10px] border border-line/16 px-3.5 py-2.5 fs-13 leading-[1.5] text-ink-100 [text-wrap:pretty]">
                {manager.line}
              </p>
            )}
            <p className="fs-13.5 leading-[1.55] text-ink-100">{whereLine(request.kind, request.name)}</p>
            {/* Never disabled while an answer is in flight: that would drop the
                focus, and after a wrong code the user types straight on. */}
            <PairingCodeInput value={code} onChange={setCode} onSubmit={() => void answer(true)} autoFocus />
            <div className="h-fit min-h-[18px] font-mono fs-11 text-ink-900/70">
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

/**
 * GROUP FULL (canvas 50o): the answer to an Accept the group had no room
 * for, in the confirmation's place rather than a toast. The kind tile stays,
 * dimmed, so it is clear who was not added; then the fact and the one way
 * out. Nothing red, nothing counts down.
 */
function FullTile({ request }: { request: PendingPair }) {
  const os = osLabel(osName(request.platform))
  return (
    <div className="flex w-full items-center gap-4 rounded-xl border border-line/16 bg-space/60 px-[18px] py-3.5 text-left opacity-60">
      <span className="grid h-[60px] w-[60px] shrink-0 place-items-center rounded-xl border border-line/20 text-ink-100">
        <KindGlyph kind={request.kind} scale={3} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <span className="font-mono fs-16 leading-(--text-base--line-height) tracking-[0.2em] text-ink-100">{kindTile(request.kind).word}</span>
        <span className="fs-12.5 leading-[1.45] text-ink-900/78">
          {os === '' ? request.name : `${request.name} · ${os}`}
        </span>
      </span>
    </div>
  )
}

/** 50o's sentence and its two ways on: Devices, where a device can be removed, and OK. */
function FullBody({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <>
      <p className="fs-13 leading-[1.55] text-ink-600/82 [text-wrap:pretty]">
        {groupFullBody(name)}
      </p>
      <div className="flex w-full gap-2.5">
        <Button
          variant="ghost"
          size="wide"
          onClick={() => {
            onClose()
            openSettingsSection('devices')
          }}
        >
          Devices
        </Button>
        <Button variant="primary" size="wide" onClick={onClose}>
          OK
        </Button>
      </div>
    </>
  )
}
