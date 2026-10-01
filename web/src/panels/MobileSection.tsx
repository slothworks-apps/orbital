import { useEffect, useRef, useState } from 'react'
import qrcode from 'qrcode-generator'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { timeAgo } from '../lib/format'
import { codeLeft, relayLine, relayUrlCommit, type RelayLineKind } from '../lib/remote'
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

/**
 * Settings → Mobile (spec 2026-10-01-settings-mobile-design § 3; canvas 9m,
 * 9n, 9q, 9r): the switch, the relay's status, the pairing code, the paired
 * phones and the relay URL. The confirmation of a pairing is not here — it
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
  const remote = useOrbital((s) => s.remote)
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
          <PairingCode remote={remote} kind={line.kind} />
        </>
      )}

      {/* Not before the first status: "No phones yet" from nothing would be a guess. */}
      {remote && <PairedPhones devices={remote.devices} onSaved={onSaved} />}

      <Advanced patchAndSet={patchAndSet} saved={settings.remote_relay_url ?? ''} remote={remote} />
    </div>
  )
}

/**
 * The QR area (canvas 9n, 9q). It follows the status line, and a code is only
 * ever drawn on a click: each one opens a window in which a phone can ask to
 * pair (spec § "Decisions").
 */
function PairingCode({ remote, kind }: { remote: RemoteStatus; kind: RelayLineKind }) {
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
      // A refusal means the status moved under the user; the next one redraws this.
      if ('error' in res) return
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

  async function tryAgain() {
    if (busy) return
    setBusy(true)
    try {
      useOrbital.getState().setRemote(await api.restartRemote())
    } catch (err) {
      reportError(err, 'Failed to restart the relay connection')
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

  if (kind === 'unreachable' || kind === 'failed') {
    return (
      <div className={`${BLOCK} flex flex-col items-start gap-2.5`}>
        <span className={`text-[12.5px] leading-[1.5] ${MUTED}`}>
          The relay didn't answer. Check the URL under Advanced, or try again.
        </span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void tryAgain()}>
          Try again
        </Button>
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
            The phone will see this Mac as <span className="text-text-bright">{remote.macName}</span>. You'll confirm a
            six-character code here before it connects.
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

/** PAIRED PHONES (canvas 9n). Listed whether the switch is on or off: the phones stay paired while it is off. */
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
                <span className={CAPTION}>
                  {device.platform} · paired {shortDate(device.pairedAt)}
                  {device.online
                    ? ' · connected · now'
                    : device.lastSeenAt !== null
                      ? ` · last seen ${timeAgo(device.lastSeenAt, now)}`
                      : ''}
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

/**
 * ADVANCED (canvas 9m, 9r): the relay URL. Committed on Enter or blur, never
 * debounced — a relay change drops every phone session, so it must not fire
 * mid-typing — and with phones paired it asks first, because they are removed.
 */
function Advanced({
  patchAndSet,
  saved,
  remote,
}: {
  patchAndSet: (patch: Record<string, string>) => Promise<void>
  saved: string
  remote: RemoteStatus | null
}) {
  const [draft, setDraft] = useState(saved)
  /** The URL waiting on the 9r confirm. */
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pairedCount = remote?.devices.length ?? 0

  // A save, a reset or another window moves the saved value: the field follows.
  useEffect(() => setDraft(saved), [saved])

  function commit(typed: string) {
    switch (relayUrlCommit(saved, typed, pairedCount)) {
      case 'none':
        setDraft(saved)
        return
      case 'save':
        void patchAndSet({ remote_relay_url: typed.trim() })
        return
      case 'ask':
        setAsking(typed.trim())
    }
  }

  function cancel() {
    if (busy) return
    setAsking(null)
    setDraft(saved)
  }

  async function changeAndRemove() {
    if (asking === null || busy) return
    setBusy(true)
    try {
      // One by one, while the Mac is still on the old relay, so each revoke
      // reaches the relay the phone paired through.
      for (const device of useOrbital.getState().remote?.devices ?? []) {
        await api.removeDevice(device.id)
      }
      // Known limitation: `patchAndSet` reports its own failure and does not
      // throw, so a failed save leaves the phones removed and the old URL kept.
      await patchAndSet({ remote_relay_url: asking })
      setAsking(null)
    } catch (err) {
      reportError(err, 'Failed to change the relay')
      setAsking(null)
      setDraft(saved)
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="group mt-3.5">
      <summary className="cursor-pointer list-none pb-1 font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)] [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="mr-1.5 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        ADVANCED · relay URL · {saved === '' ? 'default' : 'edited'}
      </summary>
      <Row title="Relay URL" desc="Self-host if you prefer. The pairing code carries it, so phones never type it.">
        <Input
          aria-label="Relay URL"
          font="mono"
          size="sm"
          value={draft}
          placeholder={saved === '' ? remote?.relayUrl : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Blurring commits, so Enter and a click away cannot both save.
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          onBlur={(e) => commit(e.target.value)}
          className="w-full"
        />
        {saved !== '' && (
          <button
            type="button"
            onClick={() => commit('')}
            className="font-mono text-[11px] text-accent/80 transition-colors hover:text-accent"
          >
            Reset to default
          </button>
        )}
        <span className={`text-[11.5px] leading-[1.5] ${MUTED}`}>
          Paired phones stay on the relay they paired through. Changing this removes them; pair them again on the new
          relay.
        </span>
      </Row>
      <Dialog
        open={asking !== null}
        size="sm"
        tone="warning"
        title="Change the relay?"
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
          {phoneCount(pairedCount)} will be removed and {pairedCount === 1 ? 'has' : 'have'} to pair again on the
          new relay.
        </p>
      </Dialog>
    </details>
  )
}
