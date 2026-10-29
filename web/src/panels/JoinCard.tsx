import { useEffect, useState, type ReactNode } from 'react'
import { parsePairingCode } from '@orbital/shared/remote/relayApi'
import { sameRelay } from '@orbital/shared/remote/relaySettings'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { checkedLabel } from '../lib/format'
import { codeLeft, pasteCodeHint, relayHostname } from '../lib/remote'
import { kindOs } from '../lib/devices'
import { groupFullLine, managerWords, notPrimaryAddLine } from '@orbital/shared/remote/groupWords'
import { useOrbital } from '../store/store'
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
    // This device, the primary, would add the other to a group with no room (canvas 50o's words).
    case 'group_full':
      return { kind: 'line', text: groupFullLine(name) }
    // Paired with a primary whose first roster has not come: one join at a time.
    case 'joining':
      return { kind: 'line', text: 'A join is still under way. Cancel it first.' }
    // The status moved under the user: this device is a member now, and only its primary adds (canvas 50l).
    case 'not_primary':
      return { kind: 'line', text: notPrimaryAddLine(res.primary.name) }
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
  // Ticks while card C's "checked …" ages and its code's time runs down; the joining card shows no clock.
  const now = useNow(outcome?.kind === 'offline')

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
      } else if (remote.group.members.some((m) => m.id === prev.device) || remote.group.pendingJoin) setOutcome(null)
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
const CARD = 'flex flex-col gap-2.5 rounded-[12px] border border-line/16 bg-shade/60 p-4'
const CARD_TITLE = 'fs-14 font-semibold text-ink-100'
const CARD_BODY = 'fs-12.5 leading-[1.5] text-ink-900/72 [text-wrap:pretty]'
/** A relay's host inside a card's sentence (canvas 50d B). */
const HOST = 'font-mono fs-11.5 text-ink-100'

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
  const pendingJoin = remote.group.pendingJoin
  if (join.joining) {
    below = <JoiningCard joining={join.joining} remote={remote} onCancel={join.cancel} />
  } else if (pendingJoin) {
    // Paired, the primary's first roster not come yet: the joining card's place, its Cancel giving the join up.
    below = <WaitingCard pending={pendingJoin} remote={remote} />
  } else if (remote.group.joinExpired) {
    // The primary never sent the group before the code ran out (canvas 50p B).
    below = <NeverSentCard primary={remote.group.joinExpired.name} />
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
          <span aria-hidden className="block h-[7px] w-[7px] box-border rounded-full border-[1.3px] border-solid border-ink-600/60" />
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
  const hint = pasteCodeHint(join.paste)
  return (
    <div className="flex flex-col gap-[7px]">
      <span className="fs-13 font-semibold text-ink-100">Have another device's code?</span>
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
      {line && <span className="font-mono fs-11 text-ink-900/78">{line}</span>}
      {/* Canvas 50a: whose code this is, once the field reads as one. */}
      {hint && <span className="font-mono fs-10 leading-[1.6] text-ink-900/55">{hint}</span>}
    </div>
  )
}

/**
 * JOINING (canvas 50b): the six characters to type on the member, the member,
 * who will manage the group, who it waits for, and Cancel. The joiner shows,
 * the member types. No clock while the user types: a code that runs out gets
 * its own card (`useJoin`).
 */
function JoiningCard({
  joining,
  remote,
  onCancel,
}: {
  joining: Joining
  remote: RemoteStatus
  onCancel: () => Promise<void>
}) {
  // A member joined by hand is in the roster already, OS and all; otherwise the code named only its kind.
  const known = remote.group.members.find((m) => m.id === joining.device)
  // A code without a kind came from a device from before kinds: a desktop.
  const kind = known?.kind ?? joining.kind ?? 'desktop'
  const { line } = managerWords(joining.manager, joining.name)
  return (
    <div className="flex flex-col items-center gap-3.5 rounded-[12px] border border-line/20 bg-shade/60 px-4 pb-4 pt-5 text-center">
      <span className="font-mono fs-9.5 tracking-[0.2em] text-ink-900/55">JOINING</span>
      <span className="fs-16 font-bold text-ink-100">
        Type {joining.code} on {joining.name}
      </span>
      <FingerprintBoxes size="sm" value={joining.code.replace('-', '')} />
      <span className="flex items-center gap-2 rounded-lg border border-line/14 bg-shade/60 px-2.5 py-1.5 font-mono fs-11 text-ink-100">
        <KindGlyph kind={kind} />
        {joining.name}
        <span className="text-ink-900/55">· {kindOs(kind, known?.os ?? '')}</span>
      </span>
      {line && <span className={`max-w-[300px] ${CARD_BODY}`}>{line}</span>}
      <span className="font-mono fs-10.5 text-ink-900/60">waiting for {joining.name}</span>
      <Button variant="outline" size="member" onClick={() => void onCancel()}>
        Cancel
      </Button>
    </div>
  )
}

/**
 * A join paired and not yet in (`group.pendingJoin`): the primary's first
 * roster has not come. In the joining card's place and voice (canvas 50p A),
 * with its Cancel, which gives the join up and ends the pair made for it. No
 * clock: when the code it was made with runs out, the status is read again,
 * and the server, dropping the join, says so (`NeverSentCard`).
 */
function WaitingCard({ pending, remote }: { pending: NonNullable<RemoteStatus['group']['pendingJoin']>; remote: RemoteStatus }) {
  const [busy, setBusy] = useState(false)
  // The pair with the primary exists by now; before it is listed, its id is all there is.
  const name = remote.devices.find((d) => d.id === pending.primary)?.name ?? pending.primary.slice(0, 8)

  // The server publishes nothing when the join's code runs out: it drops the
  // join inside its next status. So at the expiry this asks for that status, once.
  useEffect(() => {
    if (pending.expiresAt === null) return
    const timer = setTimeout(() => void useOrbital.getState().refreshRemote(), Math.max(0, pending.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [pending.expiresAt])

  async function cancel() {
    if (busy) return
    setBusy(true)
    try {
      await api.cancelJoin()
    } catch (err) {
      reportError(err, 'Failed to cancel the join')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-[12px] border border-line/20 bg-shade/60 px-4 pb-4 pt-5 text-center">
      <span className="font-mono fs-9.5 tracking-[0.2em] text-ink-900/55">JOINING</span>
      <span className="fs-16 font-bold text-ink-100">Waiting for {name}…</span>
      <span className={CARD_BODY}>Paired. This device is in once {name} sends it the group.</span>
      <span className="font-mono fs-10.5 leading-[1.6] text-ink-900/60">waiting for {name}</span>
      <Button variant="outline" size="member" disabled={busy} onClick={() => void cancel()}>
        Cancel
      </Button>
    </div>
  )
}

/**
 * The join dropped when its code ran out before the primary sent the group
 * (canvas 50p B, `group.joinExpired`): this device is still standalone.
 * Paste a new code reads it, which takes the card away.
 */
function NeverSentCard({ primary }: { primary: string }) {
  const [busy, setBusy] = useState(false)

  async function startOver() {
    if (busy) return
    setBusy(true)
    try {
      await api.acknowledgeExpiredJoin()
      // The server publishes the status without it; this tab need not wait for the hub.
      const { remote, setRemote } = useOrbital.getState()
      if (remote) setRemote({ ...remote, group: { ...remote.group, joinExpired: null } })
    } catch (err) {
      reportError(err, 'Failed to dismiss the card')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={CARD}>
      <span className={CARD_TITLE}>{primary} didn’t send the group</span>
      <span className={CARD_BODY}>
        This device is still standalone. Pair it with {primary} again when {primary} is online.
      </span>
      <Button variant="outline" size="member" className="self-start" disabled={busy} onClick={() => void startOver()}>
        Paste a new code
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
