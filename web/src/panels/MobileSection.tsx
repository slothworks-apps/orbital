import { useEffect, useRef, useState, type ReactNode } from 'react'
import qrcode from 'qrcode-generator'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { checkedLabel, timeAgo } from '../lib/format'
import {
  RELAY_CHECK_WINDOW_MS, codeLeft, relayCheckSettled, relayLine, relaySecretCommit, relayUrlCommit, relayHostname,
  statusDuringCheck, type RelayLineKind,
} from '../lib/remote'
import { useNow } from '../lib/useNow'
import type { RemoteDevice, RemoteStatus } from '../lib/types'
import { Toggle } from '../ui/Checkbox'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Input } from '../ui/Input'
import { DEBOUNCE_MS, Row, SectionLabel } from './settingsRows'

const MUTED = 'text-[rgba(160,190,225,.6)]'
const CAPTION = 'font-mono text-[11px] text-[rgba(160,190,225,.55)]'
/** A block under a section label that is not a `Row`: the same hairline rule and vertical rhythm. */
const BLOCK = 'border-t border-[rgba(150,205,255,.08)] py-[13px]'
/** "last seen" moves in minutes at the finest (`timeAgo`), so it is re-read that often. */
const LAST_SEEN_TICK_MS = 60_000

/** The status line's dot (canvas 9q). Static: it never pulses, whatever the state. */
const DOT: Record<RelayLineKind, string> = {
  off: 'bg-[rgba(160,190,225,.45)]',
  connecting: 'bg-[rgba(160,190,225,.45)]',
  online: 'bg-accent',
  unreachable: 'bg-[oklch(78%_.13_75_/_.8)]',
  failed: 'bg-[oklch(78%_.13_75_/_.8)]',
}

/**
 * The QR as SVG. The server's text goes in as it came, but as UTF-8: the
 * library's byte mode takes one byte per character, and the Mac's name in the
 * payload is free text.
 */
function qrSvg(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const qr = qrcode(0, 'M')
  qr.addData(String.fromCharCode(...bytes))
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
}

function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function phoneCount(n: number): string {
  return n === 1 ? '1 phone' : `${n} phones`
}

/** Settings → Mobile's "Try again" (canvas 11b), shared by the status line and the pairing area. */
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

/**
 * Settings → Mobile (spec 2026-10-01-settings-mobile-design § 3; canvas 9m,
 * 9n, 9q, 9r): the switch, the relay's status, the pairing code, the paired
 * phones and the relay URL and secret. The confirmation of a pairing is not here — it
 * is `PairConfirmDialog`, which belongs to the app.
 */
export function MobileSection({
  patchAndSet,
  onSaved,
}: {
  patchAndSet: (patch: Record<string, string>) => Promise<void>
  onSaved: () => void
}) {
  const settings = useOrbital(useShallow((s) => s.settings))
  const liveRemote = useOrbital((s) => s.remote)
  const { shown: remote, ...check } = useRelayCheck(liveRemote)
  const enabled = settings.remote_enabled === 'true'
  const savedMacName = settings.remote_mac_name ?? ''
  const [macNameDraft, setMacNameDraft] = useState(savedMacName)
  /** The last name this field saved, so its own save landing is not mistaken for a change from elsewhere. */
  const sentMacName = useRef<string | null>(null)

  useEffect(() => {
    if (macNameDraft === (useOrbital.getState().settings.remote_mac_name ?? '')) return
    const timer = setTimeout(() => {
      sentMacName.current = macNameDraft
      void patchAndSet({ remote_mac_name: macNameDraft })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [macNameDraft])

  // A change from elsewhere (another window) moves the field; this field's
  // own save landing does not, or it would undo what was typed since.
  useEffect(() => {
    if (savedMacName !== sentMacName.current) setMacNameDraft(savedMacName)
  }, [savedMacName])

  const line = enabled && remote ? relayLine(remote) : null

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-2">
      <SectionLabel first>PHONE ACCESS</SectionLabel>
      <Row
        title="Let a phone connect through a relay"
        desc="End-to-end encrypted between this Mac and your phone — the relay only passes encrypted bytes it can't read. No account: a phone pairs by scanning a code shown here, and you confirm it on this Mac."
      >
        <Toggle
          aria-label="Let a phone connect through a relay"
          checked={enabled}
          onChange={(checked) => void patchAndSet({ remote_enabled: checked ? 'true' : 'false' })}
        />
        {line && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 font-mono text-[11.5px] text-[rgba(200,220,245,.85)]">
              <span aria-hidden className={`block h-[7px] w-[7px] shrink-0 rounded-full ${DOT[line.kind]}`} />
              {line.text}
            </div>
            {line.detail && (
              <div className={`pl-[15px] font-mono text-[11.5px] ${MUTED} [overflow-wrap:anywhere]`}>{line.detail}</div>
            )}
          </div>
        )}
      </Row>
      <Row title="Mac name" desc="How your phone shows this Mac. Set here only — the phone can't rename it.">
        <Input
          aria-label="Mac name"
          size="sm"
          value={macNameDraft}
          placeholder={remote?.macName}
          onChange={(e) => setMacNameDraft(e.target.value)}
          className="w-full"
        />
        {/* Only while nothing is typed: then the status's name is the network's. */}
        {savedMacName === '' && remote && <span className={CAPTION}>prefilled from network name · {remote.macName}</span>}
      </Row>

      {enabled && remote && line && (
        <>
          <SectionLabel>PAIRING CODE</SectionLabel>
          <PairingCode remote={remote} kind={line.kind} check={check} />
        </>
      )}

      {/* Not before the first status: "No phones yet" from nothing would be a
          guess. While off only with rows (canvas 9m has no list): the phones
          stay paired and Remove still works, but the empty state's hint to
          scan a code means nothing without one. */}
      {liveRemote && (enabled || liveRemote.devices.length > 0) && (
        <PairedPhones devices={liveRemote.devices} onSaved={onSaved} />
      )}

      <Advanced
        patchAndSet={patchAndSet}
        savedUrl={settings.remote_relay_url ?? ''}
        savedSecret={settings.remote_relay_secret ?? ''}
        remote={liveRemote}
      />
    </div>
  )
}

/**
 * The QR area (canvas 9n, 9q). It follows the status line, and a code is only
 * ever drawn on a click: each one opens a window in which a phone can ask to
 * pair (spec § "Decisions"). A relay too old gets its own card (canvas 11b).
 */
function PairingCode({ remote, kind, check }: { remote: RemoteStatus; kind: RelayLineKind; check: RelayCheck }) {
  // The code this window drew, keyed by its `expiresAt`: the status carries
  // only the expiry, never the QR text.
  const [code, setCode] = useState<{ qr: string; expiresAt: number; svg: string } | null>(null)
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
      setCode({ ...res, svg: qrSvg(res.qr) })
      // The server publishes the status with this code before it answers, but
      // the answer can still overtake that publish; a status without the
      // code would read as expired until the publish lands.
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

  // Still the server's code. Once the status drops it before its time, it was
  // used — confirmed or rejected — and the area goes back to "New code".
  const live = code !== null && remote.pairing?.expiresAt === code.expiresAt
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

  if (kind === 'off' || kind === 'connecting') {
    return <div className={`${BLOCK} text-[12.5px] ${MUTED}`}>Waiting for the relay</div>
  }

  // No relay URL yet: nothing answered, and trying again cannot help.
  if (kind === 'failed' && remote.relayUrl === '') {
    return (
      <div className={`${BLOCK} text-[12.5px] leading-[1.5] ${MUTED}`}>Set a relay URL under Advanced to pair a phone.</div>
    )
  }

  const tryAgain = (
    <Button variant="ghost" size="sm" disabled={check.checking} onClick={() => void check.run()}>
      {check.checking ? 'Checking…' : 'Try again'}
    </Button>
  )

  if (remote.relay === 'too_old') {
    return <RelayTooOldCard remote={remote} checkedAt={check.checkedAt} tryAgain={tryAgain} />
  }

  if (kind === 'unreachable' || kind === 'failed') {
    // `failed` carries the status's own reason (the same source as
    // `relayLine`'s `detail`) — the secret's refusal among them — so it reads
    // better than the generic line, which stays for `unreachable`.
    return (
      <div className={`${BLOCK} flex flex-col items-start gap-2.5`}>
        <span className={`text-[12.5px] leading-[1.5] ${MUTED}`}>
          {kind === 'failed' && remote.error
            ? remote.error
            : "The relay didn't answer. Check the URL under Advanced, or try again."}
        </span>
        {tryAgain}
      </div>
    )
  }

  if (open && left) {
    return (
      <div className={`${BLOCK} flex items-start gap-5`}>
        <div className="shrink-0 rounded-[12px] bg-[#eef3fa] p-3">
          <div
            aria-label="Pairing code"
            role="img"
            className="block h-[200px] w-[200px] [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: code.svg }}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
          <div className="text-[13.5px] font-semibold text-text-bright">Scan this with Orbital on your phone</div>
          <div className="text-[12px] leading-[1.5] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
            The phone will see this Mac as <span className="text-text-bright">{remote.macName}</span>. You'll type the
            six-character code from the phone here before it connects.
          </div>
          <div className={`mt-1 ${CAPTION}`}>expires in {left.label}</div>
          <div className="h-[3px] w-full max-w-[220px] overflow-hidden rounded-full bg-[rgba(150,205,255,.12)]">
            {/* Drains linearly over each one-second tick, so it never jumps. */}
            <div
              className="h-full bg-accent transition-[width] duration-1000 ease-linear"
              style={{ width: `${left.fraction * 100}%` }}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`${BLOCK} flex flex-col items-start gap-2`}>
      {expired && (
        <>
          <span className="font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">CODE EXPIRED</span>
          <span className={`text-[12.5px] ${MUTED}`}>expired · make a new code to pair</span>
        </>
      )}
      <Button variant="primary" size="sm" disabled={busy} onClick={() => void newCode()}>
        New code
      </Button>
    </div>
  )
}

/**
 * The pairing area while the relay is too old (canvas 11b): the QR's frame
 * stays empty, since a code would point a phone at a relay that refuses it.
 * Type follows the QR state beside it (9n); the frame is the canvas's empty one.
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
  const now = useNow(checkedAt !== null, LAST_SEEN_TICK_MS)
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
          this Orbital supports. Whoever runs it updates the relay image; Orbital reconnects on its own. Paired phones
          can’t connect until then.
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

/**
 * A paired phone's seen text (canvas 9n, 11c): when the Mac refused its app
 * that wins — the relay may still count it online — then connected, then last
 * seen; null for a phone never seen.
 */
function seenText(device: RemoteDevice, now: number): string | null {
  if (device.needsUpdate) return `refused · ${timeAgo(device.needsUpdate.at, now)}`
  if (device.online) return 'connected · now'
  return device.lastSeenAt !== null ? `last seen ${timeAgo(device.lastSeenAt, now)}` : null
}

function Seen({ device, now }: { device: RemoteDevice; now: number }) {
  const seen = seenText(device, now)
  return seen === null ? null : <span>· {seen}</span>
}

/** PAIRED PHONES (canvas 9n). The phones stay paired while the switch is off; the caller decides when it shows. */
function PairedPhones({ devices, onSaved }: { devices: RemoteDevice[]; onSaved: () => void }) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const now = useNow(devices.length > 0, LAST_SEEN_TICK_MS)

  async function remove(id: string) {
    if (removing) return
    setRemoving(true)
    try {
      await api.removeDevice(id)
      setConfirming(null)
      onSaved()
    } catch (err) {
      reportError(err, 'Failed to remove the phone')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <>
      <SectionLabel>
        <span className="flex items-baseline gap-3">
          <span>PAIRED PHONES · {devices.length}</span>
          <span className="flex-1" />
          <span className="text-[rgba(160,190,225,.45)]">NOTIFICATIONS ARE SET ON EACH PHONE</span>
        </span>
      </SectionLabel>
      {devices.length === 0 ? (
        <div className={`${BLOCK} flex flex-col gap-1`}>
          <span className="text-[13px] font-semibold text-text-bright">No phones yet</span>
          <span className={`text-[12px] ${MUTED}`}>Scan the code above with Orbital on your phone.</span>
        </div>
      ) : (
        devices.map((device) => (
          <div key={device.id} className={`${BLOCK} flex flex-col gap-2.5`}>
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-[13.5px] font-semibold text-text-bright">{device.name}</span>
                {/* canvas 11c: a phone refused as too old wears a neutral chip
                    after its paired date, with both versions; its seen text
                    says when it was refused. Both go once it says hello on a
                    version that will do — there is nothing to dismiss. */}
                <span className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${CAPTION}`}>
                  <span>
                    {device.platform} · paired {shortDate(device.pairedAt)}
                  </span>
                  {device.needsUpdate && (
                    <>
                      <span className="rounded-full border border-[rgba(150,205,255,.14)] px-[7px] py-px text-[10.5px] text-[rgba(200,220,245,.82)]">
                        needs an update
                      </span>
                      <span className="text-[10.5px]">
                        app {device.needsUpdate.version} · this Mac needs ≥ {device.needsUpdate.needed}
                      </span>
                    </>
                  )}
                  <Seen device={device} now={now} />
                </span>
              </div>
              {confirming !== device.id && (
                <Button variant="ghost" size="sm" onClick={() => setConfirming(device.id)}>
                  Remove
                </Button>
              )}
            </div>
            {confirming === device.id && (
              <div className="flex items-center gap-3 rounded-[10px] border border-[rgba(150,205,255,.14)] bg-[rgba(4,8,16,.35)] px-3 py-2.5">
                <span className="min-w-0 flex-1 text-[12px] leading-[1.5] text-[rgba(220,235,255,.9)] [text-wrap:pretty]">
                  Remove {device.name}? It disconnects now and has to pair again.
                </span>
                <Button variant="ghost" size="sm" disabled={removing} onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button variant="danger" size="sm" disabled={removing} onClick={() => void remove(device.id)}>
                  Remove
                </Button>
              </div>
            )}
          </div>
        ))
      )}
    </>
  )
}

/** The two relay settings ADVANCED holds; a change to either removes the paired phones first. */
type RelaySetting = 'remote_relay_url' | 'remote_relay_secret'

/** The 9r confirm's words for each setting. The secret's are provisional copy: the canvas draws no such dialog yet. */
const ASK: Record<RelaySetting, { title: string; body: (phones: string, have: string) => string }> = {
  remote_relay_url: {
    title: 'Change the relay?',
    body: (phones, have) => `${phones} will be removed and ${have} to pair again on the new relay.`,
  },
  remote_relay_secret: {
    title: 'Change the relay secret?',
    body: (phones, have) => `${phones} will be removed and ${have} to pair again with the new secret.`,
  },
}

/**
 * ADVANCED (canvas 9m, 9r): the relay URL and the relay secret. Each is
 * committed on Enter or blur, never debounced — a relay change drops every
 * phone session, so it must not fire mid-typing — and with phones paired a
 * change asks first, because they are removed. The secret's row is not on the
 * canvas yet (ADR the-relay-takes-a-shared-secret): it mirrors the URL's.
 */
function Advanced({
  patchAndSet,
  savedUrl,
  savedSecret,
  remote,
}: {
  patchAndSet: (patch: Record<string, string>) => Promise<void>
  savedUrl: string
  savedSecret: string
  remote: RemoteStatus | null
}) {
  const [urlDraft, setUrlDraft] = useState(savedUrl)
  const [secretDraft, setSecretDraft] = useState(savedSecret)
  /**
   * The value waiting on the 9r confirm, and the phone count as it was when
   * the dialog opened: each removal publishes a status, and the text must not
   * count down while they go.
   */
  const [asking, setAsking] = useState<{ key: RelaySetting; value: string; count: number } | null>(null)
  // The words stay drawn through the close transition after `asking` clears.
  const asked = useRef<{ key: RelaySetting; count: number }>({ key: 'remote_relay_url', count: 0 })
  if (asking) asked.current = { key: asking.key, count: asking.count }
  const [busy, setBusy] = useState(false)
  // Unknown until the first status: whether to ask cannot be decided from nothing.
  const pairedCount = remote ? remote.devices.length : null

  // A save or another window moves the saved value: the field follows.
  useEffect(() => setUrlDraft(savedUrl), [savedUrl])
  useEffect(() => setSecretDraft(savedSecret), [savedSecret])

  function resetDraft(key: RelaySetting) {
    if (key === 'remote_relay_url') setUrlDraft(savedUrl)
    else setSecretDraft(savedSecret)
  }

  function commit(key: RelaySetting, typed: string) {
    const decision =
      key === 'remote_relay_url'
        ? relayUrlCommit(savedUrl, typed, pairedCount)
        : relaySecretCommit(savedSecret, typed, pairedCount)
    switch (decision) {
      case 'none':
        resetDraft(key)
        return
      case 'unknown':
        // The draft stays in the field; the next commit decides.
        return
      case 'save':
        void patchAndSet({ [key]: typed.trim() })
        return
      case 'ask':
        setAsking({ key, value: typed.trim(), count: pairedCount ?? 0 })
    }
  }

  function cancel() {
    if (busy || asking === null) return
    resetDraft(asking.key)
    setAsking(null)
  }

  async function changeAndRemove() {
    if (asking === null || busy) return
    setBusy(true)
    try {
      // One by one, while the Mac is still on the old relay and secret, so
      // each revoke reaches the relay the phone paired through — but only
      // while the Mac's link to the relay is up. If the relay already
      // refused the Mac's secret, the revoke is local only: the phone finds
      // out it is no longer welcome on its own next connect.
      for (const device of useOrbital.getState().remote?.devices ?? []) {
        await api.removeDevice(device.id)
      }
      // Known limitation: `patchAndSet` reports its own failure and does not
      // throw, so a failed save leaves the phones removed and the old value kept.
      await patchAndSet({ [asking.key]: asking.value })
      setAsking(null)
    } catch (err) {
      reportError(err, 'Failed to change the relay')
      resetDraft(asking.key)
      setAsking(null)
    } finally {
      setBusy(false)
    }
  }

  const ask = ASK[asked.current.key]
  const count = asked.current.count

  return (
    <details className="group mt-3.5">
      <summary className="cursor-pointer list-none pb-1 font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)] [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="mr-1.5 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        ADVANCED · relay URL · {savedUrl === '' ? 'not set' : 'set'} · secret · {savedSecret === '' ? 'not set' : 'set'}
      </summary>
      <Row title="Relay URL" desc="Self-host if you prefer. The pairing code carries it, so phones never type it.">
        <Input
          aria-label="Relay URL"
          font="mono"
          size="sm"
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
        <span className={`text-[11.5px] leading-[1.5] ${MUTED}`}>
          Paired phones stay on the relay they paired through. Changing this removes them; pair them again on the new
          relay.
        </span>
      </Row>
      {/* Provisional copy: the canvas (9m, 9r) draws no secret row yet. */}
      <Row
        title="Relay secret"
        desc="Set the same RELAY_SECRET on your relay. The pairing code carries it, so phones never type it."
      >
        <Input
          aria-label="Relay secret"
          type="password"
          font="mono"
          size="sm"
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
          {ask.body(phoneCount(count), count === 1 ? 'has' : 'have')}
        </p>
      </Dialog>
    </details>
  )
}
