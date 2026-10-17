import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import qrcode from 'qrcode-generator'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { checkedLabel } from '../lib/format'
import {
  RELAY_CHECK_WINDOW_MS, codeLeft, relayCheckSettled, relayLine, relaySecretCommit, relayUrlCommit, relayHostname,
  statusDuringCheck, type RelayLineKind,
} from '../lib/remote'
import { deviceRows, kindOs, needsUpdateLine, oneWordCode, type DeviceRow, type RowState } from '../lib/devices'
import { useNow } from '../lib/useNow'
import type { GroupMember, RemoteStatus } from '../lib/types'
import { Toggle } from '../ui/Checkbox'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Input } from '../ui/Input'
import { KindGlyph } from '../ui/KindGlyph'
import { JoinArea } from './JoinCard'
import { DEBOUNCE_MS, Row, SectionLabel } from './settingsRows'

const MUTED = 'text-[rgba(160,190,225,.6)]'
/** A block under a section label that is not a `Row`: the same hairline rule and vertical rhythm. */
const BLOCK = 'border-t border-[rgba(150,205,255,.08)] py-[13px]'
/** The kicker over each column of the group (canvas 50a: THIS DEVICE, IN THIS GROUP, ADD A DEVICE). */
const KICKER = 'font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]'
/** The quiet caption beside a kicker (canvas 50a: EVERY DEVICE SEES THIS NAME). */
const ASIDE = 'font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.45)]'
/** The cards the group's columns sit in (canvas 50a). */
const CARD = 'rounded-[12px] border border-[rgba(150,205,255,.12)] bg-[rgba(6,10,20,.55)]'
/** "offline · seen …" moves in minutes at the finest (`timeAgo`), so it is re-read that often. */
const SEEN_TICK_MS = 60_000

/** The status line's dot (canvas 9q). Static: it never pulses, whatever the state. */
const DOT: Record<RelayLineKind, string> = {
  off: 'bg-[rgba(160,190,225,.45)]',
  connecting: 'bg-[rgba(160,190,225,.45)]',
  online: 'bg-accent',
  unreachable: 'bg-[oklch(78%_.13_75_/_.8)]',
  failed: 'bg-[oklch(78%_.13_75_/_.8)]',
}

/** The hollow ring canvas 50a draws for a switch that is off and a member that is offline. */
const HOLLOW: CSSProperties = { border: '1.3px solid rgba(200,215,235,.6)' }

/**
 * A member's state dot (canvas 50a ROWS, 50k MEMBER STATE): accent while
 * online, every other state neutral — a hollow ring offline, a dashed one
 * while linking, a faint one while not linked; an ink dot while too old.
 * Nothing moves.
 */
const MEMBER_DOT: Record<Exclude<RowState, 'elsewhere'>, CSSProperties> = {
  online: { background: 'var(--color-accent)' },
  offline: HOLLOW,
  linking: { border: '1.3px dashed rgba(200,215,235,.6)' },
  notLinked: { border: '1.3px solid rgba(200,215,235,.32)' },
  // The ink dot: its Orbital is too old (50a ROWS, logic.js `update`).
  update: { background: 'rgba(232,238,248,.85)' },
}

function Dot({ style, className = '' }: { style?: CSSProperties; className?: string }) {
  return (
    <span
      aria-hidden
      className={`block h-[7px] w-[7px] shrink-0 rounded-full box-border ${className}`}
      style={style}
    />
  )
}

/**
 * The QR as SVG. The server's text goes in as it came, but as UTF-8: the
 * library's byte mode takes one byte per character, and this device's name in
 * the payload is free text.
 */
function qrSvg(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const qr = qrcode(0, 'M')
  qr.addData(String.fromCharCode(...bytes))
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
}

function longDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function deviceCount(n: number): string {
  return n === 1 ? '1 device' : `${n} devices`
}

/** Settings → Devices' "Try again" (canvas 11b), shared by the too-old card and the add-a-device box. */
interface RelayCheck {
  checking: boolean
  /** When the last check ended, while the relay is still too old; null otherwise. */
  checkedAt: number | null
  run: () => Promise<void>
}

/**
 * Resolves once a status settles the check (`relayCheckSettled`) or
 * RELAY_CHECK_WINDOW_MS runs out. Subscribed before the restart is asked
 * for, so a status published ahead of the restart's own answer is not missed.
 */
function relaySettles(): { settled: Promise<void>; cancel: () => void } {
  let cancel = () => {}
  const settled = new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const timer = setTimeout(finish, RELAY_CHECK_WINDOW_MS)
    const unsubscribe = useOrbital.subscribe((s, prev) => {
      if (s.remote !== prev.remote && s.remote && relayCheckSettled(s.remote)) finish()
    })
    cancel = finish
  })
  return { settled, cancel }
}

/**
 * One bounded check of the relay: restart the remote (it checks the relay
 * afresh) and wait for the relay's answer. While it runs on a relay too old,
 * `held` keeps that status on screen (`statusDuringCheck`), so the card stays
 * and only its button says "Checking…".
 */
function useRelayCheck(live: RemoteStatus | null): RelayCheck & { shown: RemoteStatus | null } {
  const [held, setHeld] = useState<RemoteStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)

  // A relay no longer too old drops the result line: it belongs to that refusal.
  useEffect(() => {
    if (!checking && live?.relay !== 'too_old') setCheckedAt(null)
  }, [checking, live?.relay])

  async function run() {
    const from = useOrbital.getState().remote
    if (checking || !from) return
    setChecking(true)
    setHeld(from.relay === 'too_old' ? from : null)
    const wait = relaySettles()
    try {
      const answer = await api.restartRemote()
      // A status the hub delivered first is newer than this answer.
      if (useOrbital.getState().remote === from) useOrbital.getState().setRemote(answer)
      if (relayCheckSettled(answer)) wait.cancel()
      await wait.settled
      setCheckedAt(Date.now())
    } catch (err) {
      wait.cancel()
      reportError(err, 'Failed to restart the relay connection')
    } finally {
      setHeld(null)
      setChecking(false)
    }
  }

  return { checking, checkedAt, run, shown: live ? statusDuringCheck(live, held) : null }
}

interface PairingCode {
  /** The code as drawn: the QR's SVG and the same code as one word to paste. */
  code: { expiresAt: number; svg: string; word: string } | null
  /** The code is still the server's and has time left. */
  open: boolean
  /** The code ran out by the clock. */
  expired: boolean
  left: { label: string; fraction: number } | null
  busy: boolean
  newCode: () => Promise<void>
}

/**
 * The add-a-device code (canvas 50a ADD A DEVICE): one code from
 * `api.startPairing`, drawn only on a click — Show code, New code or Pair by
 * hand — since each code opens a window in which a device can ask to pair
 * (spec 2026-10-01-settings-mobile-design, "Decisions"). Nothing renews it by
 * itself. A code the status drops before its time was used, and is forgotten.
 */
function usePairingCode(remote: RemoteStatus | null): PairingCode {
  const [code, setCode] = useState<PairingCode['code']>(null)
  const [busy, setBusy] = useState(false)
  // Ticks only while the code is open; stopped once it ran out or was used.
  const [ticking, setTicking] = useState(false)
  const now = useNow(ticking)

  async function newCode() {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.startPairing()
      if ('error' in res) {
        // The relay refused the token but stays online, so no status will
        // redraw anything: say so. `offline` / `disabled` mean the status
        // moved under the user, and the next one redraws this.
        if (res.error === 'relay_error') reportError(null, "The relay didn't answer. Try again.")
        return
      }
      setCode({ expiresAt: res.expiresAt, svg: qrSvg(res.qr), word: oneWordCode(res.qr) })
      // The server publishes the status with this code before it answers, but
      // the answer can still overtake that publish; a status without the
      // code would read as used until the publish lands.
      const { remote: current, setRemote } = useOrbital.getState()
      if (current && current.pairing?.expiresAt !== res.expiresAt) {
        setRemote({ ...current, pairing: { expiresAt: res.expiresAt } })
      }
    } catch (err) {
      reportError(err, 'Failed to make a pairing code')
    } finally {
      setBusy(false)
    }
  }

  const live = code !== null && remote?.pairing?.expiresAt === code.expiresAt
  // Timed out by the clock: the server clears an expired code only inside its
  // next status, and the label must not wait for that. A dropped code is
  // judged against the wall clock, not the stopped tick, so one dropped at
  // its expiry still reads as expired.
  const left = code ? codeLeft(code.expiresAt, live ? now : Date.now()) : null
  const expired = left?.expired === true
  const open = live && !expired

  useEffect(() => setTicking(open), [open])

  // A code dropped before its time was used: forget it, so it never comes
  // back as "expired" once its time has passed.
  useEffect(() => {
    if (code && !live && !codeLeft(code.expiresAt, Date.now()).expired) setCode(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live])

  return { code, open, expired, left, busy, newCode }
}

/**
 * Settings → Devices (spec 2026-10-16-device-group-design; canvas 50a): the
 * switch and the relay, this device, every other member of the group, the
 * code that adds a device, the field that joins another's group, and Leave.
 * It replaces Settings → Mobile in the same place (50a REPLACES MOBILE). The
 * confirmation of a pairing is not here — it is `PairConfirmDialog`, which
 * belongs to the app.
 */
export function DevicesSection({
  patchAndSet,
  onSaved,
}: {
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
  onSaved: () => void
}) {
  const settings = useOrbital(useShallow((s) => s.settings))
  const liveRemote = useOrbital((s) => s.remote)
  const { shown: remote, ...check } = useRelayCheck(liveRemote)
  const enabled = settings.remote_enabled === 'true'
  const [relayOpen, setRelayOpen] = useState(false)
  /** A relay URL card B (canvas 50d) asked to move to: committed through the Relay field, as if typed there. */
  const [proposedRelay, setProposedRelay] = useState<{ url: string } | null>(null)
  /** The member Pair by hand was asked for: the add-a-device box is titled for it (50a ADD A DEVICE). */
  const [pairFor, setPairFor] = useState<string | null>(null)

  const line = enabled && remote ? relayLine(remote) : null
  const online = line?.kind === 'online' && remote?.relay === 'online'
  const pairing = usePairingCode(liveRemote)

  const members = liveRemote?.group.members ?? []
  const self = members.find((m) => m.self) ?? null
  const others = members.filter((m) => !m.self)
  const now = useNow(true, SEEN_TICK_MS)
  const rows = deviceRows(members, liveRemote?.devices ?? [], now)
  const relayLocked = liveRemote?.group.relayLocked ?? false
  // Only while that member still waits on a hand pairing: once it links, the box is everyone's again.
  const pairTarget = others.find((m) => m.id === pairFor && m.state === 'notLinked') ?? null

  function pairByHand(m: DeviceRow) {
    setPairFor(m.id)
    void pairing.newCode()
  }

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-2">
      <SectionLabel first>REMOTE</SectionLabel>
      <Row
        narrow
        title="Connect this device to the group"
        desc="Through a relay, end-to-end encrypted — the relay sees only encrypted bytes; no account. Off: this device stops reaching the others and they stop reaching it. Its own sessions keep running."
      >
        <Toggle
          aria-label="Connect this device to the group"
          checked={enabled}
          onChange={(checked) => void patchAndSet({ remote_enabled: checked ? 'true' : 'false' })}
        />
        {!enabled ? (
          <div className="flex items-center gap-2 font-mono text-[11px] text-[rgba(200,220,245,.82)]">
            <Dot style={HOLLOW} />
            off · this device is on its own
          </div>
        ) : (
          line && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 font-mono text-[11px] text-[rgba(200,220,245,.82)]">
                <Dot className={DOT[line.kind]} />
                {line.text}
              </div>
              {line.detail && (
                <div className={`pl-[15px] font-mono text-[11px] ${MUTED} [overflow-wrap:anywhere]`}>{line.detail}</div>
              )}
            </div>
          )
        )}
        {/* canvas 50a: a dashed text link, not a button's box. */}
        <button
          type="button"
          aria-expanded={relayOpen}
          onClick={() => setRelayOpen((o) => !o)}
          className="cursor-pointer border-b border-dashed border-[rgba(160,190,225,.45)] font-mono text-[10.5px] tracking-[0.06em] text-[rgba(200,220,245,.8)]"
        >
          {relayOpen ? 'Done' : 'Change relay'}
        </button>
      </Row>

      {relayOpen && (
        <RelaySettings
          patchAndSet={patchAndSet}
          savedUrl={settings.remote_relay_url ?? ''}
          savedSecret={settings.remote_relay_secret ?? ''}
          remote={liveRemote}
          locked={relayLocked}
          proposed={proposedRelay}
          onProposedDone={() => setProposedRelay(null)}
        />
      )}

      {enabled && remote?.relay === 'too_old' && (
        <RelayTooOldCard remote={remote} checkedAt={check.checkedAt} tryAgain={<TryAgain check={check} />} />
      )}

      {/* Not before the first status: a group read from nothing would be a guess. */}
      {liveRemote && (
        <div
          className={`grid grid-cols-[minmax(0,1fr)_300px] items-start gap-8 border-t border-[rgba(150,205,255,.08)] pt-1.5 transition-opacity duration-[250ms] ease-[ease] ${enabled ? '' : 'opacity-40'}`}
        >
          {/* Stays live with the switch off: a removal applies here at once,
              and Remove is the way out of a member that keeps the relay locked. */}
          <div className="flex min-w-0 flex-col">
            <div className={`${KICKER} pb-2 pt-2.5`}>THIS DEVICE</div>
            <ThisDevice
              patchAndSet={patchAndSet}
              self={self}
              savedName={settings.remote_mac_name ?? ''}
              networkName={liveRemote.macName}
            />
            <div className="flex items-baseline gap-2.5 pb-2 pt-5">
              <span className={KICKER}>IN THIS GROUP · {rows.length}</span>
              <span className="flex-1" />
              <span className={ASIDE}>ANY MEMBER CAN REMOVE ANY DEVICE</span>
            </div>
            {rows.length === 0 ? (
              <div className="flex items-center gap-3.5 rounded-[12px] border border-dashed border-[rgba(150,205,255,.16)] px-4 py-[18px]">
                <span className="flex flex-col gap-[3px]">
                  <span className="text-[13.5px] font-semibold text-text-bright">Just this device</span>
                  <span className="text-[12.5px] text-[rgba(160,190,225,.65)]">
                    {/* The device being added reads 50b's words; one alone, 50a's. */}
                    {liveRemote.joining
                      ? "Paste a code from any device in your group, or show this device's code to one of them."
                      : 'Add another with the code on the right, or paste one of theirs.'}
                  </span>
                </span>
              </div>
            ) : (
              <Members rows={rows} now={now} onPairByHand={pairByHand} onSaved={onSaved} />
            )}
          </div>
          <div className={`flex min-w-0 flex-col ${enabled ? '' : 'pointer-events-none'}`}>
            <div className={`${KICKER} pb-2 pt-2.5`}>
              {pairTarget ? `ADD A DEVICE · FOR ${pairTarget.name.toUpperCase()}` : 'ADD A DEVICE'}
            </div>
            <JoinArea
              remote={liveRemote}
              onUseRelay={(url) => {
                setRelayOpen(true)
                setProposedRelay({ url })
              }}
              idle={(field) => (
                <div className={`${CARD} flex flex-col gap-3.5 p-4`}>
                  {/* A relay too old has its card above; a code would point at a relay that refuses it. */}
                  {remote?.relay !== 'too_old' && (
                    <>
                      {online ? (
                        <CodeArea pairing={pairing} />
                      ) : (
                        <RelayWait kind={line?.kind ?? 'off'} remote={remote} check={check} />
                      )}
                      <div className="h-px bg-[rgba(150,205,255,.1)]" />
                    </>
                  )}
                  {field}
                </div>
              )}
            />
            {others.length > 0 && <Leave count={others.length} relayOnline={online} />}
          </div>
        </div>
      )}
    </div>
  )
}

function TryAgain({ check }: { check: RelayCheck }) {
  return (
    <Button variant="ghost" size="sm" disabled={check.checking} onClick={() => void check.run()}>
      {check.checking ? 'Checking…' : 'Try again'}
    </Button>
  )
}

/** The add-a-device box while the relay is not online: why there is no code, and Try again where it can help. */
function RelayWait({ kind, remote, check }: { kind: RelayLineKind; remote: RemoteStatus | null; check: RelayCheck }) {
  // No relay URL yet: nothing answered, and trying again cannot help.
  if (kind === 'failed' && remote?.relayUrl === '') {
    return <span className={`text-[12.5px] leading-[1.5] ${MUTED}`}>Set a relay under Change relay to add a device.</span>
  }
  if ((kind === 'unreachable' || kind === 'failed') && remote?.relay !== 'too_old') {
    // `failed` carries the status's own reason (the same source as
    // `relayLine`'s `detail`) — the secret's refusal among them — so it reads
    // better than the generic line, which stays for `unreachable`.
    return (
      <div className="flex flex-col items-start gap-2.5">
        <span className={`text-[12.5px] leading-[1.5] ${MUTED}`}>
          {kind === 'failed' && remote?.error
            ? remote.error
            : "The relay didn't answer. Check it under Change relay, or try again."}
        </span>
        <TryAgain check={check} />
      </div>
    )
  }
  return <span className={`text-[12.5px] ${MUTED}`}>Waiting for the relay</span>
}

/** The code twice, as a QR for a phone and one word for a desktop or a server, and its expiry (canvas 50a). */
function CodeArea({ pairing }: { pairing: PairingCode }) {
  const { code, open, expired, left } = pairing
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [code?.expiresAt])
  const faded = open ? '' : 'opacity-30'

  async function copy() {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code.word)
      setCopied(true)
    } catch (err) {
      reportError(err, 'Failed to copy the code')
    }
  }

  return (
    <>
      <div className="flex items-center gap-3.5">
        <div className="relative h-[124px] w-[124px] shrink-0">
          <div className={`box-border h-[124px] w-[124px] rounded-[10px] bg-text-bright p-2 ${faded}`}>
            {code && (
              <div
                aria-label="Pairing code"
                role="img"
                className="block h-full w-full [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: code.svg }}
              />
            )}
          </div>
          {!open && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-[9px] rounded-[10px] bg-[rgba(5,7,13,.88)]">
              {expired && (
                <span className="font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.7)]">CODE EXPIRED</span>
              )}
              {/* No code until asked for: each one opens a window in which a device can ask to pair. */}
              <Button variant="primary-flat" size="over-code" disabled={pairing.busy} onClick={() => void pairing.newCode()}>
                {expired ? 'New code' : 'Show code'}
              </Button>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className="text-[13px] font-semibold text-text-bright">For a phone</span>
          <span className="text-[12px] leading-[1.5] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
            Scan it with Orbital on the phone.
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-[7px]">
        <span className="text-[13px] font-semibold text-text-bright">For a desktop or a server</span>
        <div className="flex gap-1.5">
          {/* Double-click selects it all (50a ADD A DEVICE). */}
          <span
            className={`min-w-0 flex-1 select-all overflow-hidden text-ellipsis whitespace-nowrap rounded-lg border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.6)] px-2.5 py-[7px] font-mono text-[11.5px] text-text-bright ${faded}`}
          >
            {code?.word ?? ''}
          </span>
          <Button variant="outline" size="beside-field" disabled={!open} onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {/* 50a also draws `on a server: orbital join …`; it comes back with the headless server's command. */}
        <span className="font-mono text-[10px] leading-[1.6] text-[rgba(160,190,225,.55)]">
          paste it in Devices there
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="h-[3px] overflow-hidden rounded-[2px] bg-[rgba(150,205,255,.12)]">
          {/* Drains linearly over each one-second tick, so it never jumps. */}
          <span
            className="block h-full bg-accent/70 transition-[width] duration-1000 ease-linear"
            style={{ width: `${open && left ? left.fraction * 100 : 0}%` }}
          />
        </div>
        <span className="min-h-[1lh] font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
          {open && left ? `expires in ${left.label} · one device per code` : expired ? 'expired · make a new code' : ''}
        </span>
      </div>
    </>
  )
}

/** THIS DEVICE (canvas 50a): its glyph, its name — renamed in place, every member sees it — and its kind and OS. */
function ThisDevice({
  patchAndSet,
  self,
  savedName,
  networkName,
}: {
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
  self: GroupMember | null
  savedName: string
  networkName: string
}) {
  const [draft, setDraft] = useState(savedName)
  /** The last name this field saved, so its own save landing is not mistaken for a change from elsewhere. */
  const sent = useRef<string | null>(null)

  useEffect(() => {
    if (draft === (useOrbital.getState().settings.remote_mac_name ?? '')) return
    const timer = setTimeout(() => {
      sent.current = draft
      void patchAndSet({ remote_mac_name: draft })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // A change from elsewhere (another window) moves the field; this field's
  // own save landing does not, or it would undo what was typed since.
  useEffect(() => {
    if (savedName !== sent.current) setDraft(savedName)
  }, [savedName])

  // Before this device has an identity it has no roster entry: it is a desktop, its OS not known yet.
  const kind = self?.kind ?? 'desktop'
  return (
    <div className={`${CARD} box-border flex min-h-[60px] items-center gap-3.5 px-4 py-2`}>
      <span className="flex text-text-bright">
        <KindGlyph kind={kind} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <label className="flex cursor-text items-center gap-2 self-start border-b border-dashed border-[rgba(150,205,255,.35)] pb-px">
          <span className="block w-[170px]">
            <Input
              variant="bare"
              aria-label="This device's name"
              spellCheck={false}
              value={draft}
              placeholder={networkName}
              onChange={(e) => setDraft(e.target.value)}
            />
          </span>
          <span aria-hidden className="text-[11px] text-[rgba(160,190,225,.6)]">
            ✎
          </span>
        </label>
        <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">{kindOs(kind, self?.os ?? '')}</span>
      </span>
      <span className={ASIDE}>EVERY DEVICE SEES THIS NAME</span>
    </div>
  )
}

/**
 * IN THIS GROUP's rows (canvas 50a ROWS): glyph, name, kind and OS, the quiet
 * added-by line with its date on hover, and the state as a dot and words. A
 * row's Remove asks in place first. Remove stays available with the relay
 * offline: the removal applies here at once, and it is the only way out of a
 * member that keeps the relay locked.
 */
function Members({
  rows,
  now,
  onPairByHand,
  onSaved,
}: {
  rows: DeviceRow[]
  now: number
  onPairByHand: (m: DeviceRow) => void
  onSaved: () => void
}) {
  const [asking, setAsking] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)

  async function remove(id: string) {
    if (removing) return
    setRemoving(true)
    try {
      await api.removeDevice(id)
      setAsking(null)
      onSaved()
    } catch (err) {
      reportError(err, 'Failed to remove the device')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className={`${CARD} overflow-hidden`}>
      {rows.map((m, i) => {
        const { state, words } = m
        const nameInk = state === 'offline' ? 'text-[rgba(232,238,248,.62)]' : 'text-text-bright'
        return (
          <div
            key={m.id}
            data-member={m.id}
            className={i === 0 ? '' : 'border-t border-[rgba(150,205,255,.08)]'}
          >
            {asking !== m.id ? (
              <div className="box-border flex min-h-[58px] items-center gap-3.5 py-2 pl-4 pr-3">
                <span className={`flex ${nameInk}`}>
                  <KindGlyph kind={m.kind} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={`truncate text-[13.5px] font-semibold ${nameInk}`}>{m.name}</span>
                  <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">{kindOs(m.kind, m.os)}</span>
                  {m.needsUpdate && (
                    <span className="font-mono text-[10px] text-[rgba(160,190,225,.6)]">
                      {needsUpdateLine(m.needsUpdate, now)}
                    </span>
                  )}
                  <span title={longDate(m.addedAt)} className="font-mono text-[10px] text-[rgba(160,190,225,.42)]">
                    {m.added}
                  </span>
                </span>
                <span
                  className={`flex w-[172px] flex-none items-center gap-[7px] font-mono text-[11px] ${
                    state === 'online' ? 'text-[rgba(200,220,245,.85)]' : 'text-[rgba(160,190,225,.72)]'
                  }`}
                >
                  {/* A phone paired with another member has no presence here, so no dot. */}
                  {state !== 'elsewhere' && <Dot style={MEMBER_DOT[state]} />}
                  {state === 'notLinked' ? (
                    <button
                      type="button"
                      onClick={() => onPairByHand(m)}
                      className="cursor-pointer border-b border-dashed border-[rgba(160,190,225,.5)] text-left"
                    >
                      {words}
                    </button>
                  ) : (
                    <span>{words}</span>
                  )}
                </span>
                <Button variant="outline" size="member" onClick={() => setAsking(m.id)}>
                  Remove
                </Button>
              </div>
            ) : (
              <div className="box-border flex min-h-[58px] items-center gap-2.5 bg-[rgba(150,205,255,.05)] py-2 pl-4 pr-3">
                <span className="flex-1 text-[12.5px] leading-[1.45] text-text-bright [text-wrap:pretty]">
                  Remove {m.name}?{' '}
                  <span className="text-[rgba(160,190,225,.7)]">
                    It drops out of every device in the group now and has to join again.
                  </span>
                </span>
                <Button variant="outline" size="member" disabled={removing} onClick={() => setAsking(null)}>
                  Cancel
                </Button>
                <Button variant="ink" size="member" disabled={removing} onClick={() => void remove(m.id)}>
                  Remove
                </Button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Leave this group (canvas 50a), only while another member exists. It asks
 * in place; a relay that cannot carry the leave answers `offline`, said in the
 * same place, and nothing else changes until the relay is back.
 */
function Leave({ count, relayOnline }: { count: number; relayOnline: boolean }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)

  // The refusal was about the relay; once it is back, Leave can be asked again.
  useEffect(() => {
    if (relayOnline) setOffline(false)
  }, [relayOnline])

  async function leave() {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.leaveGroup()
      setAsking(false)
      if (!res.ok) {
        if (res.error === 'offline') setOffline(true)
        else reportError(null, "Couldn't leave the group. Try again.")
      }
    } catch (err) {
      setAsking(false)
      reportError(err, 'Failed to leave the group')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 rounded-[12px] border border-[rgba(150,205,255,.12)] px-4 py-3">
      {!asking ? (
        <div className="flex items-center gap-3">
          <span className="flex flex-1 flex-col gap-[3px]">
            <span className="text-[13px] font-semibold text-text-bright">Leave this group</span>
            <span className="text-[12px] leading-[1.45] text-[rgba(160,190,225,.7)]">
              {offline ? 'Connect to the relay to leave — the others have to hear it.' : 'Sessions here keep running.'}
            </span>
          </span>
          <Button
            variant="outline"
            size="member"
            onClick={() => {
              setOffline(false)
              setAsking(true)
            }}
          >
            Leave…
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <span className="text-[12.5px] leading-[1.5] text-text-bright [text-wrap:pretty]">
            Leave?{' '}
            <span className="text-[rgba(160,190,225,.7)]">
              {count === 1
                ? "This device forgets the other device and its keys; it stops seeing this device's sessions."
                : `This device forgets the other ${count} and their keys; they stop seeing its sessions.`}
            </span>
          </span>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="member" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button variant="ink" size="member" disabled={busy} onClick={() => void leave()}>
              Leave
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The relay while it is too old (canvas 11b): the QR's frame stays empty,
 * since a code would point a device at a relay that refuses it. Type follows
 * the QR state beside it (9n); the frame is the canvas's empty one.
 */
function RelayTooOldCard({
  remote,
  checkedAt,
  tryAgain,
}: {
  remote: RemoteStatus
  checkedAt: number | null
  tryAgain: ReactNode
}) {
  const now = useNow(checkedAt !== null, SEEN_TICK_MS)
  const host = relayHostname(remote.relayUrl)
  const version = remote.relayTooOld?.relayVersion
  return (
    <div className={`${BLOCK} flex items-center gap-7`}>
      <div
        aria-hidden
        className="h-[150px] w-[150px] shrink-0 rounded-[12px] border border-dashed border-[rgba(150,205,255,.16)] bg-[rgba(6,10,20,.5)]"
      />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
        <div className="text-[13.5px] font-semibold text-text-bright">The relay needs an update</div>
        <div className="max-w-[460px] text-[12px] leading-[1.6] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
          The relay at <span className="font-mono text-text-bright">{host}</span> refused the connection: it’s older than
          this Orbital supports. Whoever runs it updates the relay image; Orbital reconnects on its own. The other
          devices can’t connect until then.
        </div>
        {checkedAt !== null && (
          <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
            still {version ?? 'an older relay'} · {checkedLabel(checkedAt, now)}
          </span>
        )}
        {tryAgain}
      </div>
    </div>
  )
}

/** The two relay settings Change relay opens; a change to either removes the paired devices first. */
type RelaySetting = 'remote_relay_url' | 'remote_relay_secret'

/** The 9r confirm's words for each setting. The secret's are provisional copy: the canvas draws no such dialog yet. */
const ASK: Record<RelaySetting, { title: string; body: (devices: string, have: string) => string }> = {
  remote_relay_url: {
    title: 'Change the relay?',
    body: (devices, have) => `${devices} will be removed and ${have} to pair again on the new relay.`,
  },
  remote_relay_secret: {
    title: 'Change the relay secret?',
    body: (devices, have) => `${devices} will be removed and ${have} to pair again with the new secret.`,
  },
}

/**
 * Change relay (canvas 50a, 9r): the relay URL and the relay secret. Each is
 * committed on Enter or blur, never debounced — a relay change drops every
 * connection, so it must not fire mid-typing — and with devices paired a
 * change asks first, because they are removed. In a group (`locked`) both are
 * read-only: one relay serves the whole group, and moving it is not built.
 * The secret's row is not on the canvas yet (ADR
 * the-relay-takes-a-shared-secret): it mirrors the URL's.
 */
function RelaySettings({
  patchAndSet,
  savedUrl,
  savedSecret,
  remote,
  locked,
  proposed,
  onProposedDone,
}: {
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
  savedUrl: string
  savedSecret: string
  remote: RemoteStatus | null
  locked: boolean
  /** A URL to commit as if typed here (card B's Use <relay>); a new object each time it is asked. */
  proposed: { url: string } | null
  /** The proposal was committed: it is forgotten, so reopening the panel never commits it again. */
  onProposedDone: () => void
}) {
  const [urlDraft, setUrlDraft] = useState(savedUrl)
  const [secretDraft, setSecretDraft] = useState(savedSecret)
  /**
   * The value waiting on the 9r confirm, and the device count as it was when
   * the dialog opened: each removal publishes a status, and the text must not
   * count down while they go.
   */
  const [asking, setAsking] = useState<{ key: RelaySetting; value: string; count: number } | null>(null)
  // The words stay drawn through the close transition after `asking` clears.
  const asked = useRef<{ key: RelaySetting; count: number }>({ key: 'remote_relay_url', count: 0 })
  if (asking) asked.current = { key: asking.key, count: asking.count }
  const [busy, setBusy] = useState(false)
  /** The URL a proposal last committed: the field's own blur with it in the field adds no second save or ask. */
  const proposedUrl = useRef<string | null>(null)
  // Unknown until the first status: whether to ask cannot be decided from nothing.
  const pairedCount = remote ? remote.devices.length : null

  // A save or another window moves the saved value: the field follows.
  useEffect(() => {
    setUrlDraft(savedUrl)
    proposedUrl.current = null
  }, [savedUrl])
  useEffect(() => setSecretDraft(savedSecret), [savedSecret])

  function resetDraft(key: RelaySetting) {
    if (key === 'remote_relay_url') setUrlDraft(savedUrl)
    else setSecretDraft(savedSecret)
  }

  /** Commits a typed value; true when it saved or asked, so something is now under way for it. */
  function commit(key: RelaySetting, typed: string): boolean {
    if (locked) {
      resetDraft(key)
      return false
    }
    if (key === 'remote_relay_url' && typed.trim() === proposedUrl.current) return false
    const decision =
      key === 'remote_relay_url'
        ? relayUrlCommit(savedUrl, typed, pairedCount)
        : relaySecretCommit(savedSecret, typed, pairedCount)
    switch (decision) {
      case 'none':
        resetDraft(key)
        return false
      case 'unknown':
        // The draft stays in the field; the next commit decides.
        return false
      case 'save':
        void patchAndSet({ [key]: typed.trim() }).then((saved) => {
          // A proposal that failed to save leaves the field free: the same URL blurred again saves it.
          if (!saved && key === 'remote_relay_url' && proposedUrl.current === typed.trim()) proposedUrl.current = null
        })
        return true
      case 'ask':
        setAsking({ key, value: typed.trim(), count: pairedCount ?? 0 })
        return true
    }
  }

  function cancel() {
    if (busy || asking === null) return
    resetDraft(asking.key)
    setAsking(null)
    proposedUrl.current = null
  }

  async function changeAndRemove() {
    if (asking === null || busy) return
    setBusy(true)
    try {
      // One by one, while this device is still on the old relay and secret,
      // so each revoke reaches the relay the device paired through — but only
      // while the link to the relay is up. If the relay already refused the
      // secret, the revoke is local only: the device finds out it is no
      // longer welcome on its own next connect.
      for (const device of useOrbital.getState().remote?.devices ?? []) {
        await api.removeDevice(device.id)
      }
      // Known limitation: `patchAndSet` reports its own failure and does not
      // throw, so a failed save leaves the devices removed and the old value kept.
      const saved = await patchAndSet({ [asking.key]: asking.value })
      if (!saved && asking.key === 'remote_relay_url') proposedUrl.current = null
      setAsking(null)
    } catch (err) {
      reportError(err, 'Failed to change the relay')
      resetDraft(asking.key)
      setAsking(null)
    } finally {
      setBusy(false)
    }
  }

  // Card B's Use <relay>: the same commit as Enter in the field, with its confirm when devices are paired.
  useEffect(() => {
    if (!proposed) return
    setUrlDraft(proposed.url)
    proposedUrl.current = null
    // Only a proposal that saved or asked has a blur left to swallow; one that changed nothing leaves the field free.
    if (commit('remote_relay_url', proposed.url)) proposedUrl.current = proposed.url.trim()
    onProposedDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposed])

  const ask = ASK[asked.current.key]
  const count = asked.current.count

  return (
    <>
      <Row
        narrow
        title="Relay"
        desc={
          locked
            ? 'One relay for the whole group. Remove the other devices, or leave, to change it.'
            : 'Self-host if you prefer. The pairing code carries it, so no other device ever types it.'
        }
      >
        <Input
          aria-label="Relay URL"
          font="mono"
          size="sm"
          spellCheck={false}
          readOnly={locked}
          value={urlDraft}
          placeholder="https://relay.example.com"
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => {
            // Blurring commits, so Enter and a click away cannot both save.
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          onBlur={(e) => commit('remote_relay_url', e.target.value)}
          className="w-full"
        />
      </Row>
      {/* Provisional copy: the canvas (50a, 9r) draws no secret row yet. */}
      <Row
        narrow
        title="Relay secret"
        desc="Set the same RELAY_SECRET on your relay. The pairing code carries it, so no other device ever types it."
      >
        <Input
          aria-label="Relay secret"
          type="password"
          font="mono"
          size="sm"
          readOnly={locked}
          value={secretDraft}
          placeholder="none"
          onChange={(e) => setSecretDraft(e.target.value)}
          onKeyDown={(e) => {
            // Blurring commits, so Enter and a click away cannot both save.
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          onBlur={(e) => commit('remote_relay_secret', e.target.value)}
          className="w-full"
        />
      </Row>
      <Dialog
        open={asking !== null}
        size="sm"
        tone="warning"
        title={ask.title}
        onClose={cancel}
        footer={
          <>
            <Button variant="ghost" size="lg" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
            <Button variant="warning" size="lg" disabled={busy} onClick={() => void changeAndRemove()}>
              Change and remove
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
          {ask.body(deviceCount(count), count === 1 ? 'has' : 'have')}
        </p>
      </Dialog>
    </>
  )
}
