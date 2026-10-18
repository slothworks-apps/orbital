import { useEffect, useState, type ReactNode } from 'react'
import { parsePairingCode } from '@orbital/shared/remote/relayApi'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { checkedLabel } from '../lib/format'
import { codeLeft, relayHostname } from '../lib/remote'
import { kindOs } from '../lib/devices'
import { useNow } from '../lib/useNow'
import type { JoinAnswer, RemoteStatus } from '../lib/types'
import { Button } from '../ui/Button'
import { FingerprintBoxes } from '../ui/FingerprintBoxes'
import { Input } from '../ui/Input'
import { KindGlyph } from '../ui/KindGlyph'

/**
 * What the last Join came to, short of a join under way (that one is the
 * status's `joining`). `line`: one quiet line under the field. The rest are
 * the cards of canvas 50d (B other relay, C offline, D expired) and the
 * rejected request.
 */
type Outcome =
  | { kind: 'line'; text: string }
  | { kind: 'otherRelay'; name: string; relay: string }
  | { kind: 'offline'; name: string; code: string; expiresAt: number | null; checkedAt: number }
  | { kind: 'expired'; name: string }
  | { kind: 'rejected'; name: string }

type Joining = NonNullable<RemoteStatus['joining']>

const NOT_A_CODE = "That isn't a device code."

/** A relay URL as two devices compare it: a trailing slash does not make it another relay. */
function sameRelay(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
}

/** One join, told apart from the next one with the same device by its code's expiry. */
function joinKey(j: Joining | null | undefined): string | null {
  return j ? `${j.device}:${j.expiresAt}` : null
}

/** A refusal the server answered for a code that read fine here, as what to show. */
function refusal(res: Exclude<JoinAnswer, { ok: true }>, name: string, code: string, expiresAt: number | undefined): Outcome {
  switch (res.error) {
    case 'in_group':
      return { kind: 'line', text: 'This device is already in a group. Leave it first, then join.' }
    case 'other_relay':
      return { kind: 'otherRelay', name, relay: res.relay }
    case 'peer_offline':
      return { kind: 'offline', name, code, expiresAt: res.expiresAt ?? expiresAt ?? null, checkedAt: Date.now() }
    // The relay does not know the code's token: it was used, or it ran out.
    case 'bad_code':
      return { kind: 'expired', name }
    case 'already_paired':
      return { kind: 'line', text: `This device is already paired with ${name}.` }
    case 'disabled':
    case 'offline':
      return { kind: 'line', text: 'Connect to the relay to join.' }
    case 'relay_too_old':
      return { kind: 'line', text: 'The relay needs an update first.' }
    case 'relay_error':
      return { kind: 'line', text: "The relay didn't answer. Try again." }
  }
}

/**
 * Joining another device's group by its code (canvas 50b, 50d B–D). The code
 * is read here before anything is sent: text that is no code, this device's
 * own, one from another relay and one already run out are answered without a
 * request. A code that passes goes to the server once per Join or Try again
 * — nothing is sent again by itself.
 *
 * The join under way is the status's `joining`, so it survives a reload.
 * When it clears, the member being in the group means it accepted (the list
 * fills in place, 50b AFTER); not being there means it rejected; the code's
 * clock running out first reads as expired.
 */
function useJoin(remote: RemoteStatus) {
  const [paste, setPaste] = useState('')
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)
  const joining = remote.joining
  const key = joinKey(joining)
  /** The join whose end was already drawn, or cancelled here: its clearing draws nothing more. */
  const [ended, setEnded] = useState<string | null>(null)
  const [prev, setPrev] = useState<Joining | null>(joining)

  // While a Join is in flight the server publishes its `joining` before it
  // posts the code to the relay and clears it again if the relay refuses:
  // that is not a join under way yet, and the answer settles what to show.
  // A join whose code ran out is never one under way: the server does not
  // publish its end, so it can linger in the status long after.
  const waiting = joining !== null && joining.expiresAt > Date.now() && key !== ended && !busy
  // Ticks while a countdown is on screen, and while card C's "checked …" ages.
  const now = useNow(waiting || outcome?.kind === 'offline')

  // The waiting join's code runs out by the clock: card D, once, for that join.
  useEffect(() => {
    if (!waiting || !joining) return
    const timer = setTimeout(() => {
      setEnded(joinKey(joining))
      setOutcome({ kind: 'expired', name: joining.name })
    }, joining.expiresAt - Date.now())
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, key])

  // The status moved from one join to none (or to another).
  if (joinKey(prev) !== key) {
    setPrev(joining)
    // In flight, nothing here is an outcome yet: `send` settles it when the answer lands.
    if (!busy && joining) {
      setOutcome(null)
      setPaste('')
    }
    if (!busy && prev && joinKey(prev) !== ended) {
      setEnded(joinKey(prev))
      // A join whose code ran out had its end drawn by the clock, if it was on screen at all.
      if (Date.now() >= prev.expiresAt) {
        /* nothing more */
      } else if (remote.group.members.some((m) => m.id === prev.device)) setOutcome(null)
      // Only a relay that is still up can have carried a rejection.
      else if (!joining && remote.enabled && remote.relay === 'online') setOutcome({ kind: 'rejected', name: prev.name })
    }
  }

  async function send(code: string, name: string, expiresAt: number | undefined) {
    // The server keys a join again by the same device and expiry: a join
    // cancelled or ended earlier must not hide this one.
    setEnded(null)
    setBusy(true)
    try {
      const res = await api.joinGroup(code)
      if (res.ok) {
        // The status the server published before it answered carries the join.
        setOutcome(null)
        setPaste('')
      } else {
        setOutcome(refusal(res, name, code, expiresAt))
      }
    } finally {
      setBusy(false)
    }
  }

  async function join() {
    const code = paste.trim()
    if (busy || code === '') return
    const qr = parsePairingCode(code)
    if (!qr) return setOutcome({ kind: 'line', text: NOT_A_CODE })
    if (remote.macId !== null && qr.mac === remote.macId) {
      return setOutcome({ kind: 'line', text: "That's this device's own code." })
    }
    // The relay rides inside the code, so this is caught before any request (50d B).
    if (!sameRelay(qr.relay, remote.relayUrl)) return setOutcome({ kind: 'otherRelay', name: qr.name, relay: qr.relay })
    if (qr.expiresAt !== undefined && qr.expiresAt <= Date.now()) return setOutcome({ kind: 'expired', name: qr.name })
    await send(code, qr.name, qr.expiresAt)
  }

  /** Card C's Try again: one more check of the same code. */
  async function tryAgain() {
    if (busy || outcome?.kind !== 'offline') return
    await send(outcome.code, outcome.name, outcome.expiresAt ?? undefined)
  }

  async function cancel() {
    if (!joining) return
    setEnded(key)
    try {
      await api.cancelJoin()
    } catch (err) {
      setEnded(null)
      reportError(err, 'Failed to cancel the join')
    }
  }

  function edit(text: string) {
    setPaste(text)
    if (!busy) setOutcome(null)
  }

  function startOver() {
    setOutcome(null)
    setPaste('')
  }

  return { paste, edit, busy, outcome, now, joining: waiting ? joining : null, join, tryAgain, cancel, startOver }
}

type Join = ReturnType<typeof useJoin>

/** The cards of canvas 50d B–D and the rejected request. */
const CARD = 'flex flex-col gap-2.5 rounded-[12px] border border-[rgba(150,205,255,.16)] bg-[rgba(6,10,20,.6)] p-4'
const CARD_TITLE = 'text-[14px] font-semibold text-text-bright'
const CARD_BODY = 'text-[12.5px] leading-[1.5] text-[rgba(160,190,225,.72)] [text-wrap:pretty]'
/** A relay's host inside a card's sentence (canvas 50d B). */
const HOST = 'font-mono text-[11.5px] text-text-bright'

/**
 * The join box of ADD A DEVICE: the field and Join while nothing is under
 * way (`idle` draws the box around it), the JOINING card while the status
 * has a join (50b), and the card a refusal or the join's end calls for (50d).
 * `onUseRelay` moves this device to the code's relay, the way the Relay
 * field does.
 */
export function JoinArea({
  remote,
  onUseRelay,
  idle,
}: {
  remote: RemoteStatus
  onUseRelay: (url: string) => void
  idle: (field: ReactNode) => ReactNode
}) {
  const join = useJoin(remote)
  const { outcome, now } = join

  // Card C's code running out turns it to D, as the joining card does.
  const offlineRanOut = outcome?.kind === 'offline' && outcome.expiresAt !== null && now >= outcome.expiresAt

  /** The card in the box's place (canvas 50b): the join under way, or how it ended. */
  let below: ReactNode = null
  if (join.joining) {
    below = <JoiningCard joining={join.joining} remote={remote} now={now} onCancel={join.cancel} />
  } else if (outcome?.kind === 'expired' || offlineRanOut) {
    below = (
      <EndCard
        title="Code expired"
        body={`Codes last two minutes. Make a new one on ${outcome.name} and paste it again.`}
        onStartOver={join.startOver}
      />
    )
  } else if (outcome?.kind === 'rejected') {
    // Provisional copy: the canvas draws no rejected card on the joining side.
    below = (
      <EndCard
        title="Request rejected"
        body={`${outcome.name} didn't let this device in. Make a new code on ${outcome.name} and paste it again.`}
        onStartOver={join.startOver}
      />
    )
  }

  /** What cards B and C say under the field (canvas 50d B, C). */
  let message: ReactNode = null
  // Once this device is on the code's relay, card B has said what it had to.
  if (outcome?.kind === 'otherRelay' && !sameRelay(outcome.relay, remote.relayUrl)) {
    const theirs = relayHostname(outcome.relay)
    message = (
      <>
        <span className={CARD_TITLE}>{outcome.name} uses another relay</span>
        <span className={CARD_BODY}>
          It's on <span className={HOST}>{theirs}</span>;{' '}
          {remote.relayUrl === '' ? (
            'this device has no relay yet.'
          ) : (
            <>
              this device is on <span className={HOST}>{relayHostname(remote.relayUrl)}</span>.
            </>
          )}{' '}
          Both need the same one.
        </span>
        {/* The one-click switch only while this device is alone (50d B); a group keeps its relay. */}
        {remote.group.relayLocked ? (
          <span className={CARD_BODY}>Leave this group first to change relays.</span>
        ) : (
          <Button
            variant="outline"
            size="member"
            className="self-start"
            // Keeps a draft in the Relay field from blurring into a save of its own first: the proposal wins.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onUseRelay(outcome.relay)}
          >
            Use {theirs}
          </Button>
        )}
      </>
    )
  } else if (outcome?.kind === 'offline' && !offlineRanOut) {
    const left = outcome.expiresAt !== null ? codeLeft(outcome.expiresAt, now).label : null
    const checked = checkedLabel(outcome.checkedAt, now)
    message = (
      <>
        <span className={`flex items-center gap-2 ${CARD_TITLE}`}>
          {/* The offline member's hollow ring (canvas 50d C). */}
          <span aria-hidden className="block h-[7px] w-[7px] box-border rounded-full border-[1.3px] border-solid border-[rgba(200,215,235,.6)]" />
          {outcome.name} is offline
        </span>
        <span className={CARD_BODY}>
          {checked.charAt(0).toUpperCase() + checked.slice(1)}.{' '}
          {left !== null
            ? `Its code is good for another ${left} — try again once ${outcome.name} is awake.`
            : `Try again once ${outcome.name} is awake.`}
        </span>
        <Button variant="outline" size="member" className="self-start" disabled={join.busy} onClick={() => void join.tryAgain()}>
          Try again
        </Button>
      </>
    )
  }

  // The join under way or its end takes the box's place (canvas 50b).
  if (below) return below
  const field = <JoinField join={join} />
  // Cards B and C: the field on top, what it came to under it (canvas 50d).
  if (message) {
    return (
      <div className={CARD}>
        {field}
        {message}
      </div>
    )
  }
  return idle(field)
}

/** "Have another device's code?" (canvas 50a): the field, Join, and a refusal's one line under them. */
function JoinField({ join }: { join: Join }) {
  const code = join.paste.trim()
  const line = join.outcome?.kind === 'line' ? join.outcome.text : null
  return (
    <div className="flex flex-col gap-[7px]">
      <span className="text-[13px] font-semibold text-text-bright">Have another device's code?</span>
      <div className="flex gap-1.5">
        <Input
          aria-label="Another device's code"
          font="mono"
          size="sm"
          spellCheck={false}
          placeholder="Paste it here"
          value={join.paste}
          onChange={(e) => join.edit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void join.join()
          }}
          className="min-w-0 flex-1"
        />
        <Button variant="outline" size="beside-field" disabled={code === '' || join.busy} onClick={() => void join.join()}>
          Join
        </Button>
      </div>
      {/* The quiet line of canvas 50d A. */}
      {line && <span className="font-mono text-[11px] text-[rgba(160,190,225,.78)]">{line}</span>}
    </div>
  )
}

/**
 * JOINING (canvas 50b): the six characters to type on the member, the member,
 * the code's countdown, and Cancel. The joiner shows, the member types.
 */
function JoiningCard({
  joining,
  remote,
  now,
  onCancel,
}: {
  joining: Joining
  remote: RemoteStatus
  now: number
  onCancel: () => Promise<void>
}) {
  // A member joined by hand is in the roster already, OS and all; otherwise the code named only its kind.
  const known = remote.group.members.find((m) => m.id === joining.device)
  // A code without a kind came from a device from before kinds: a desktop.
  const kind = known?.kind ?? joining.kind ?? 'desktop'
  const left = codeLeft(joining.expiresAt, now)
  return (
    <div className="flex flex-col items-center gap-3.5 rounded-[12px] border border-[rgba(150,205,255,.2)] bg-[rgba(6,10,20,.6)] px-4 pb-4 pt-5 text-center">
      <span className="font-mono text-[9.5px] tracking-[0.2em] text-[rgba(160,190,225,.55)]">JOINING</span>
      <span className="text-[16px] font-bold text-text-bright">
        Type {joining.code} on {joining.name}
      </span>
      <FingerprintBoxes size="sm" value={joining.code.replace('-', '')} />
      <span className="flex items-center gap-2 rounded-lg border border-[rgba(150,205,255,.14)] bg-[rgba(4,8,16,.6)] px-2.5 py-1.5 font-mono text-[11px] text-text-bright">
        <KindGlyph kind={kind} />
        {joining.name}
        <span className="text-[rgba(160,190,225,.55)]">· {kindOs(kind, known?.os ?? '')}</span>
      </span>
      <div className="flex w-[220px] flex-col gap-1.5">
        <div className="h-[3px] overflow-hidden rounded-[2px] bg-[rgba(150,205,255,.12)]">
          {/* Drains linearly over each one-second tick, as the code's own bar does (50a). */}
          <span
            className="block h-full bg-accent/70 transition-[width] duration-1000 ease-linear"
            style={{ width: `${left.fraction * 100}%` }}
          />
        </div>
        <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">waiting · code expires in {left.label}</span>
      </div>
      <Button variant="outline" size="member" onClick={() => void onCancel()}>
        Cancel
      </Button>
    </div>
  )
}

/** Card D (canvas 50d) and the rejected request: why it ended, and the way back to the field. */
function EndCard({ title, body, onStartOver }: { title: string; body: string; onStartOver: () => void }) {
  return (
    <div className={CARD}>
      <span className={CARD_TITLE}>{title}</span>
      <span className={CARD_BODY}>{body}</span>
      <Button variant="outline" size="member" className="self-start" onClick={onStartOver}>
        Paste a new code
      </Button>
    </div>
  )
}
