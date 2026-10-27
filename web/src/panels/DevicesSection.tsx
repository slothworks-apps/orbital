import { useEffect, useRef, useState, type ReactNode } from 'react'
import qrcode from 'qrcode-generator'
import { useShallow } from 'zustand/react/shallow'
import { encodePairingCode } from '@orbital/shared/remote/relayApi'
import { relaySecretCommit, relayUrlCommit } from '@orbital/shared/remote/relaySettings'
import { useAppUpdate } from '../store/appUpdate'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { selfUpdateStrip } from '../lib/appUpdate'
import { reportError } from '../lib/errors'
import { checkedLabel } from '../lib/format'
import {
  RELAY_CHECK_WINDOW_MS, codeLeft, relayCheckSettled, relayLine, relayHostname,
  statusDuringCheck, type RelayLineKind,
} from '../lib/remote'
import {
  canRemoveRow, cancelMemberUpdate, deviceRows, endedNotice, groupView, kindOs, memberServesUpdate, needsUpdateLine,
  readMemberUpdate, startMemberUpdate, type DeviceRow, type GroupView,
} from '../lib/devices'
import {
  UPDATE_UNREACHABLE, UPDATE_UNREACHABLE_CANCEL, selfUpdateAvailable, updatePhase, updateRow, type MemberUpdate,
} from '../lib/memberUpdate'
import { useMemberUpdates, type UpdateIo, type UpdateTarget } from '../lib/useMemberUpdates'
import { useNow } from '../lib/useNow'
import {
  UPDATE_NOW, UPDATE_WHEN_IDLE, exitWords, notPrimaryAddLine, notPrimaryRemoveLine, relayChangeWords, relayLockedLine,
  removeWords, updateAvailableLine, updateSessionsWords,
} from '@orbital/shared/remote/groupWords'
import type { GroupEnded, GroupMember, RemoteStatus } from '../lib/types'
import type { UpdateWhen } from '@orbital/shared/remote/serverUpdate'
import { Toggle } from '../ui/Checkbox'
import { Button } from '../ui/Button'
import { Collapse } from '../ui/Collapse'
import { Dialog } from '../ui/Dialog'
import { Input } from '../ui/Input'
import { KindGlyph } from '../ui/KindGlyph'
import { MemberDot } from '../ui/MemberDot'
import { PrimaryLabel } from '../ui/PrimaryLabel'
import { JoinArea } from './JoinCard'
import { DEBOUNCE_MS, GroupLine, Row, SectionLabel, useGroupSharing } from './settingsRows'

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
/** How much of the code `orbital join …` shows under the field (canvas 50a, 50q: `orb1q7kf…`). */
const SERVER_CODE_SHOWN = 8
/** The quiet mono line under a row's state or name (canvas 50q). */
const SUBLINE = 'font-mono text-[10.5px] text-[rgba(160,190,225,.5)]'

/** The status line's dot (canvas 9q). Static: it never pulses, whatever the state. */
const DOT: Record<RelayLineKind, string> = {
  off: 'bg-[rgba(160,190,225,.45)]',
  connecting: 'bg-[rgba(160,190,225,.45)]',
  online: 'bg-accent',
  unreachable: 'bg-[oklch(78%_.13_75_/_.8)]',
  failed: 'bg-[oklch(78%_.13_75_/_.8)]',
}

/** The status line's dot (canvas 9q), 7 px like a member's. */
function Dot({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={`block h-[7px] w-[7px] shrink-0 rounded-full ${className}`}
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
  /** Why the last ask made no code, said under the code rather than as a toast (canvas 50p I); null otherwise. */
  error: string | null
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
  const [error, setError] = useState<string | null>(null)
  // Ticks only while the code is open; stopped once it ran out or was used.
  const [ticking, setTicking] = useState(false)
  const now = useNow(ticking)

  async function newCode() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.startPairing()
      if ('error' in res) {
        // The relay refused the token but stays online, so no status will
        // redraw anything: say so. `offline` / `disabled` mean the status
        // moved under the user, and the next one redraws this.
        if (res.error === 'relay_error') setError("The relay didn't answer. Try again.")
        // Paired with a primary whose first roster has not come: one join at a time.
        else if (res.error === 'joining') setError('A join is still under way. Cancel it first.')
        // The status moved under the user: this device is a member now (canvas 50p I).
        else if (res.error === 'not_primary') setError(notPrimaryAddLine(res.primary.name))
        return
      }
      setCode({ expiresAt: res.expiresAt, svg: qrSvg(res.qr), word: encodePairingCode(res.qr) })
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

  return { code, open, expired, left, busy, error, newCode }
}

/**
 * Settings → Devices (spec 2026-10-16-device-group-design; canvas 50a, 50l,
 * 50m): the switch and the relay, this device, every other member of the
 * group, and what this device's place in the group offers (`groupView`) — on
 * the primary or a device in no group the code that adds a device and the
 * field that joins another's, Remove on the rows and Dissolve; on a member
 * the primary's name in their place, and Leave. A notice of the group's
 * ending by the primary's hand heads IN THIS GROUP until OK. It replaces
 * Settings → Mobile in the same place (50a REPLACES MOBILE). The
 * confirmation of a pairing is not here — it is `PairConfirmDialog`, which
 * belongs to the app.
 */
export function DevicesSection({
  patchAndSet,
  onSaved,
  onOpenUpdates,
}: {
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
  onSaved: () => void
  /** Settings → Updates, where this Mac's own update lives (canvas 50u A); absent where there is no such section. */
  onOpenUpdates?: () => void
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
  const view = groupView(liveRemote?.group ?? { primary: null, isPrimary: false }, others.length)
  const rows = deviceRows(members, liveRemote?.devices ?? [], now, view.pairsByHand)
  const ended = liveRemote?.group.ended ?? null
  const relayLocked = liveRemote?.group.relayLocked ?? false
  // Only while that member still waits on a hand pairing: once it links, the box is everyone's again.
  const pairTarget = others.find((m) => m.id === pairFor && m.state === 'notLinked') ?? null
  const updates = useMemberUpdates(updateTargets(members), memberUpdateIo(members))
  const primaryMember = members.find((m) => m.primary && !m.self) ?? null
  const primaryPhase = primaryMember
    ? updatePhase(updates.byId[primaryMember.id], primaryMember.state === 'online')
    : 'idle'

  function pairByHand(m: DeviceRow) {
    setPairFor(m.id)
    void pairing.newCode()
  }

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-2">
      <GroupLine />
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
            {/* Canvas 50a: the hollow ring of an offline member, for a switch that is off. */}
            <MemberDot state="offline" sizePx={7} />
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
        {relayLocked ? (
          // Canvas 50a `relayLock`, 50p C: in a group the relay cannot change, and this says how it can again.
          <span className="max-w-[300px] text-[11.5px] leading-[1.5] text-[rgba(160,190,225,.65)] [text-wrap:pretty]">
            {relayLockedLine(view.role === 'member' ? 'member' : 'primary')}
          </span>
        ) : (
          // canvas 50a: a dashed text link, not a button's box.
          <button
            type="button"
            aria-expanded={relayOpen}
            onClick={() => setRelayOpen((o) => !o)}
            className="cursor-pointer border-b border-dashed border-[rgba(160,190,225,.45)] font-mono text-[10.5px] tracking-[0.06em] text-[rgba(200,220,245,.8)]"
          >
            {relayOpen ? 'Done' : 'Change relay'}
          </button>
        )}
      </Row>

      {/* Only out of a group (canvas 50a `relayOpen && !inGroup`): one relay serves the whole group. */}
      {relayOpen && !relayLocked && (
        <RelaySettings
          patchAndSet={patchAndSet}
          savedUrl={settings.remote_relay_url ?? ''}
          savedSecret={settings.remote_relay_secret ?? ''}
          remote={liveRemote}
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
            <div className="flex items-center gap-2.5 pb-2 pt-2.5">
              <span className={KICKER}>THIS DEVICE</span>
              {view.selfPrimary && <PrimaryLabel />}
            </div>
            <ThisDevice
              patchAndSet={patchAndSet}
              self={self}
              savedName={settings.remote_mac_name ?? ''}
              networkName={liveRemote.macName}
              update={self ? updates.byId[self.id] : undefined}
              onOpenUpdates={onOpenUpdates}
            />
            <div className="flex items-baseline gap-2.5 pb-2 pt-5">
              <span className={KICKER}>IN THIS GROUP · {rows.length}</span>
              <span className="flex-1" />
              {view.selfPrimary && <span className={ASIDE}>ONLY THE PRIMARY ADDS OR REMOVES</span>}
            </div>
            {ended && <EndedNotice ended={ended} />}
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
              <Members
                rows={rows}
                view={view}
                now={now}
                onPairByHand={pairByHand}
                onSaved={onSaved}
                updates={updates}
                selfId={self?.id ?? null}
              />
            )}
          </div>
          <div className={`flex min-w-0 flex-col ${enabled ? '' : 'pointer-events-none'}`}>
            <div className={`${KICKER} pb-2 pt-2.5`}>
              {view.canAdd && pairTarget ? `ADD A DEVICE · FOR ${pairTarget.name.toUpperCase()}` : 'ADD A DEVICE'}
            </div>
            {view.managedBy !== null ? (
              <Managed
                primary={view.managedBy}
                kind={primaryMember?.kind ?? 'desktop'}
                updating={primaryPhase === 'installing' || primaryPhase === 'restarting'}
              />
            ) : (
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
            )}
            {view.exit && (
              <Leave
                exit={view.exit}
                count={others.length}
                primary={liveRemote.group.primary?.name ?? ''}
                relayOnline={online}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The members Settings → Devices asks about their updates: every member that
 * serves the routes (`memberServesUpdate` — never a phone), readable now
 * while it is this device or online and not too old. One that is not
 * readable is still watched while it updates, read as unreachable.
 */
function updateTargets(members: GroupMember[]): UpdateTarget[] {
  return members
    .filter((m) => memberServesUpdate(m))
    .map((m) => ({ id: m.id, readable: m.self || (m.state === 'online' && !m.tooOld) }))
}

/** The desktop asks only through the gated `readMemberUpdate` / `startMemberUpdate` / `cancelMemberUpdate`. */
function memberUpdateIo(members: GroupMember[]): UpdateIo {
  const find = (id: string) => members.find((m) => m.id === id)
  return {
    read: async (id) => {
      const m = find(id)
      return m ? readMemberUpdate(m) : null
    },
    start: async (id, when) => {
      const m = find(id)
      return m ? startMemberUpdate(m, when) : null
    },
    cancel: async (id) => {
      const m = find(id)
      return m ? cancelMemberUpdate(m) : null
    },
  }
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
        {/* Canvas 50a, 50q: the code's start stands for it in the server's command. */}
        <span className="font-mono text-[10px] leading-[1.6] text-[rgba(160,190,225,.55)]">
          paste it in Devices there · on a server:
          <br />
          orbital join{code ? ` ${code.word.slice(0, SERVER_CODE_SHOWN)}…` : ''}
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
        {pairing.error && (
          <span role="alert" className="text-[12.5px] leading-[1.5] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
            {pairing.error}
          </span>
        )}
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
  update,
  onOpenUpdates,
}: {
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
  self: GroupMember | null
  savedName: string
  networkName: string
  update: MemberUpdate | undefined
  onOpenUpdates?: () => void
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
  const version = update?.state?.installed ?? self?.version ?? null
  // Canvas 50u A: this Mac's own update is Settings → Updates'; the row only points there.
  // Canvas 50v: an update another member started here, as the map prompt says it.
  const appUpdate = useAppUpdate((s) => s.state)
  const strip = selfUpdateStrip(appUpdate)
  const available = selfUpdateAvailable(update)
  const line = strip ? strip.line : available ? updateAvailableLine(available) : null
  const link = strip ? strip.link : true
  return (
    <div className={CARD}>
      <div className="box-border flex min-h-[60px] items-center gap-3.5 px-4 py-2">
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
          <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
            {kindOs(kind, self?.os ?? '', self?.osVersion)}
            {version ? ` · ${version}` : ''}
            {version && strip?.to ? ` → ${strip.to}` : ''}
          </span>
        </span>
        <span className={ASIDE}>EVERY DEVICE SEES THIS NAME</span>
      </div>
      {line && (
        <div className="-mt-1 flex items-center gap-2.5 pb-3 pl-[42px] pr-4">
          <span className="flex-1 font-mono text-[11px] text-[rgba(200,220,245,.85)]">{line}</span>
          {link && onOpenUpdates && (
            <Button variant="dashed-link" size="link-mono" onClick={onOpenUpdates}>
              Settings → Updates ›
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** Grant group labels and descriptions. */
const GRANT_LABELS: Record<string, { label: string; desc: string }> = {
  sessions: { label: 'Read and drive sessions', desc: "messages, decisions, interrupt, harness, a session's MCP servers" },
  spawn: { label: 'Start sessions', desc: 'new sessions, folders, projects' },
  settings: { label: 'Settings, tags and templates', desc: '' },
  manage: { label: 'Upkeep of this Mac', desc: 'profiles, errors, branch status' },
  ide: { label: 'IDE on this Mac', desc: "open files and diagnostics in this Mac's editor" },
}

const GRANT_GROUPS: Array<keyof typeof GRANT_LABELS> = ['sessions', 'spawn', 'settings', 'manage', 'ide']

/** Canvas 50a's word for how many of a member's grants are on. */
function grantSummary(grants: Record<string, boolean>): string {
  const n = GRANT_GROUPS.filter((g) => grants[g]).length
  return n === GRANT_GROUPS.length ? 'all allowed' : n === 0 ? 'none allowed' : `${n} of ${GRANT_GROUPS.length} allowed`
}

/**
 * Grant toggles for a member (spec 2026-10-19-member-grants-design § 2,
 * canvas `Feature - Device group 2` 50a): folded under one line that says how
 * many are on, which opens and closes them.
 */
function GrantToggles({
  memberId,
  name,
  grants,
  saving,
  onToggle,
}: {
  memberId: string
  name: string
  grants: Record<string, boolean> | undefined
  saving: string | null
  onToggle: (memberId: string, group: string, checked: boolean) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  if (!grants) return null
  const panelId = `grants-${memberId}`
  return (
    <div className="-mt-2 flex flex-col pl-[42px] pr-3">
      <Button
        variant="dashed-link"
        size="grant-summary"
        className="mb-2.5 self-start"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        Permissions on this Mac ·<span className="text-[rgba(200,220,245,.88)]">{grantSummary(grants)}</span>
        <span
          aria-hidden
          className={`inline-grid w-2.5 place-items-center text-[rgba(160,190,225,.55)] transition-transform duration-[220ms] ${open ? 'rotate-90' : ''}`}
        >
          ›
        </span>
      </Button>
      <Collapse open={open} id={panelId}>
        <div className="flex flex-col border-t border-[rgba(150,205,255,.08)] pb-2 pt-1">
          <span className="pb-0.5 pt-1.5 font-mono text-[9.5px] tracking-[.14em] text-[rgba(160,190,225,.5)]">
            WHAT {name.toUpperCase()} MAY DO ON THIS MAC
          </span>
          {GRANT_GROUPS.map((group) => {
            const { label, desc } = GRANT_LABELS[group]
            const busy = saving === `${memberId}-${group}`
            return (
              <div key={group} className="flex items-start gap-3 py-[7px]">
                <span className="mt-px">
                  <Toggle
                    aria-label={label}
                    checked={grants[group] ?? false}
                    disabled={busy}
                    onChange={(checked) => void onToggle(memberId, group, checked)}
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[12.5px] font-semibold text-text-bright">{label}</span>
                  {desc && (
                    <span className="text-[11.5px] leading-[1.45] text-[rgba(160,190,225,.62)] [text-wrap:pretty]">{desc}</span>
                  )}
                </span>
                <span className="w-16 shrink-0 pt-0.5 text-right font-mono text-[10px] text-[rgba(160,190,225,.55)]">
                  {busy ? 'saving…' : ''}
                </span>
              </div>
            )
          })}
        </div>
      </Collapse>
    </div>
  )
}

/**
 * IN THIS GROUP's rows (canvas 50a ROWS, 50l, 50q): glyph, name with PRIMARY
 * on the primary's row, kind and OS on the quiet line under it, and the
 * state as a dot and words with the version under them. Remove asks in place
 * first, and only where `view` offers it (`canRemoveRow`); a row not linked
 * is a Pair by hand link only on the primary. Remove stays available with the
 * relay offline: the removal applies here at once, and it is the only way out
 * of a member that keeps the relay locked. Under each other member, what it
 * may do on this device (spec 2026-10-19-member-grants-design § 2).
 *
 * A member's update (canvas 50q, 50t; `updateRow`): one line under the row —
 * available, waiting, installing, restarting, failed — with Update, Try
 * again or Cancel (a wait) only while it can be asked. With sessions running
 * there, Update first asks in place, as Remove does, with the local
 * Restart's three choices.
 */
function Members({
  rows,
  view,
  now,
  onPairByHand,
  onSaved,
  updates,
  selfId,
}: {
  rows: DeviceRow[]
  view: GroupView
  now: number
  onPairByHand: (m: DeviceRow) => void
  onSaved: () => void
  updates: ReturnType<typeof useMemberUpdates>
  selfId: string | null
}) {
  const [asking, setAsking] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  /**
   * The member whose Update waits on the sessions confirm, and the count it
   * first named: once Update now found more running, it says how many
   * started since (canvas 50t CONFIRM · MORE SESSIONS STARTED).
   */
  const [confirm, setConfirm] = useState<{ id: string; shown: number; recount: boolean } | null>(null)
  const askingUpdate = confirm?.id ?? null
  const setAskingUpdate = (id: string | null) =>
    setConfirm(id === null ? null : { id, shown: updates.byId[id]?.state?.sessions ?? 0, recount: false })
  /** A removal the group refused, said under that row rather than as a toast (canvas 50p I). */
  const [refusal, setRefusal] = useState<{ id: string; text: string } | null>(null)
  /** Member grants from /api/remote/grants. */
  const [grants, setGrants] = useState<Record<string, Record<string, boolean>>>({})
  /** Which grant is currently being saved. */
  const [saving, setSaving] = useState<string | null>(null)
  /** A grant save that failed, said under that member rather than as a toast. */
  const [saveError, setSaveError] = useState<{ memberId: string; text: string } | null>(null)
  /** The Macs and servers too old to share settings, said on their rows as the group line says it. */
  const { old: notSharing } = useGroupSharing()

  const memberIds = rows.map((m) => m.id).join(',')
  useEffect(() => {
    let live = true
    api
      .getRemoteGrants()
      .then((res) => {
        if (live) setGrants(res.grants)
      })
      .catch(() => {
        /* the toggles stay unrendered; see the state's comment */
      })
    return () => {
      live = false
    }
  }, [memberIds])

  async function remove(id: string) {
    if (removing) return
    setRemoving(true)
    try {
      const res = await api.removeDevice(id)
      setAsking(null)
      // The status moved under the user: this device is no primary any more.
      if (typeof res === 'object') setRefusal({ id, text: notPrimaryRemoveLine(res.primary.name) })
      else onSaved()
    } catch (err) {
      reportError(err, 'Failed to remove the device')
    } finally {
      setRemoving(false)
    }
  }

  async function toggleGrant(memberId: string, group: string, checked: boolean) {
    if (saving === `${memberId}-${group}`) return
    setSaving(`${memberId}-${group}`)
    setSaveError(null)
    // Optimistic update
    const oldGrants = grants[memberId]
    setGrants((g) => ({
      ...g,
      [memberId]: { ...g[memberId], [group]: checked },
    }))
    try {
      const { grants: updated } = await api.updateRemoteGrants(memberId, { [group]: checked })
      setGrants((g) => ({ ...g, [memberId]: updated }))
      onSaved()
    } catch (err) {
      // Rollback on failure
      if (oldGrants) setGrants((g) => ({ ...g, [memberId]: oldGrants }))
      setSaveError({ memberId, text: 'Failed to save grant' })
      reportError(err, 'Failed to update member grants')
    } finally {
      setSaving(null)
    }
  }

  /** Update or Try again: the member is read again, and that answer decides whether to ask first. */
  async function pressUpdate(id: string) {
    setAsking(null)
    setRefusal(null)
    const result = await updates.press(id)
    if (result === 'confirm') setAskingUpdate(id)
    // Said under the row, as a refused removal is, never as a toast.
    else if (result === 'unreachable') setRefusal({ id, text: UPDATE_UNREACHABLE })
  }

  /** The confirm's Update now or Update when sessions finish; Update now asks again, with the new count, when more sessions run there now. */
  async function confirmUpdate(id: string, when: UpdateWhen) {
    const result = await updates.start(id, when)
    if (result === 'confirm') {
      setConfirm((c) => (c?.id === id ? { ...c, recount: true } : c))
      return
    }
    setAskingUpdate(null)
    if (result === 'unreachable') setRefusal({ id, text: UPDATE_UNREACHABLE })
  }

  /** Cancel on a member that waits for its sessions: no confirm (canvas 50t WAITING). */
  async function cancelUpdate(id: string) {
    setRefusal(null)
    const result = await updates.cancel(id)
    if (result === 'unreachable') setRefusal({ id, text: UPDATE_UNREACHABLE_CANCEL })
  }

  return (
    <div className={`${CARD} overflow-hidden`}>
      {rows.map((m, i) => {
        const u = m.member ? updates.byId[m.id] : undefined
        const update = updateRow(u, {
          name: m.name, kind: m.kind, online: m.state === 'online', words: m.words,
          helloVersion: m.version, selfId, surface: 'desktop',
        })
        const { state } = m
        const away = update.dim ?? state === 'offline'
        const nameInk = away ? 'text-[rgba(232,238,248,.62)]' : 'text-text-bright'
        const confirming = askingUpdate === m.id
        const sessionsWords = updateSessionsWords(
          u?.state?.sessions ?? 0, m.name, confirming && confirm?.recount ? confirm.shown : undefined,
        )
        const line = confirming ? null : update.line
        return (
          <div
            key={m.id}
            data-member={m.id}
            title={`joined ${longDate(m.addedAt)}`}
            className={[
              i === 0 ? '' : 'border-t border-[rgba(150,205,255,.08)]',
              // Canvas 50q: the confirm tints the whole row, as Remove's does.
              confirming ? 'bg-[rgba(150,205,255,.05)]' : '',
            ].join(' ')}
          >
            {asking !== m.id ? (
              <div className="box-border flex min-h-[58px] items-center gap-3.5 py-2 pl-4 pr-3">
                <span className={`flex ${nameInk}`}>
                  <KindGlyph kind={m.kind} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`truncate text-[13.5px] font-semibold ${nameInk}`}>
                      {m.name}
                    </span>
                    {m.primary && <PrimaryLabel />}
                  </span>
                  <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">{kindOs(m.kind, m.os, m.osVersion)}</span>
                  {notSharing.some((o) => o.id === m.id) && (
                    // In the needs-update line's type: the row's own quiet words.
                    <span className="font-mono text-[10px] text-[rgba(160,190,225,.6)]">
                      doesn’t share settings yet — update it
                    </span>
                  )}
                  {m.needsUpdate && (
                    <span className="font-mono text-[10px] text-[rgba(160,190,225,.6)]">
                      {needsUpdateLine(m.needsUpdate, now)}
                    </span>
                  )}
                </span>
                {/* Canvas 50q: the version under the state, at the height of the kind · OS line. */}
                <span className="flex w-[172px] flex-none flex-col gap-0.5">
                  <span
                    className={`flex items-center gap-[7px] font-mono text-[11px] ${
                      !away && (state === 'online' || update.dim === false)
                        ? 'text-[rgba(200,220,245,.85)]'
                        : 'text-[rgba(160,190,225,.72)]'
                    }`}
                  >
                    {/* A phone paired with another member has no presence here, so no dot. */}
                    {state !== 'elsewhere' && <MemberDot state={update.dot ?? state} sizePx={7} />}
                    {state === 'notLinked' && view.pairsByHand ? (
                      <Button variant="dashed-link" size="inline" onClick={() => onPairByHand(m)}>
                        {update.words}
                      </Button>
                    ) : (
                      <span>{update.words}</span>
                    )}
                  </span>
                  {update.version && <span className={`pl-3.5 ${SUBLINE}`}>{update.version}</span>}
                </span>
                {canRemoveRow(view, m) && (
                  <Button
                    variant="outline"
                    size="member"
                    onClick={() => {
                      setRefusal(null)
                      setAskingUpdate(null)
                      setAsking(m.id)
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>
            ) : (
              <div className="box-border flex min-h-[58px] items-center gap-2.5 bg-[rgba(150,205,255,.05)] py-2 pl-4 pr-3">
                <span className="flex-1 text-[12.5px] leading-[1.45] text-text-bright [text-wrap:pretty]">
                  {removeWords(m.name).question}{' '}
                  <span className="text-[rgba(160,190,225,.7)]">{removeWords(m.name).body}</span>
                </span>
                <Button variant="outline" size="member" disabled={removing} onClick={() => setAsking(null)}>
                  Cancel
                </Button>
                <Button variant="ink" size="member" disabled={removing} onClick={() => void remove(m.id)}>
                  Remove
                </Button>
              </div>
            )}
            {asking !== m.id && line && (
              <div className="-mt-1 flex min-h-8 items-center gap-2.5 pb-2.5 pl-[42px] pr-3">
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span
                    className={`font-mono text-[11px] ${line.bright ? 'text-[rgba(200,220,245,.85)]' : 'text-[rgba(160,190,225,.72)]'}`}
                  >
                    {line.text}
                  </span>
                  {line.sub && <span className={SUBLINE}>{line.sub}</span>}
                </span>
                {line.action && (
                  <Button
                    variant="outline"
                    size="member-line"
                    disabled={updates.starting !== null}
                    onClick={() => void (line.action === 'cancel' ? cancelUpdate(m.id) : pressUpdate(m.id))}
                  >
                    {line.action === 'retry' ? 'Try again' : line.action === 'cancel' ? 'Cancel' : 'Update'}
                  </Button>
                )}
              </div>
            )}
            {asking !== m.id && confirming && (
              // Canvas 50q/50t CONFIRM: the words, then the local Restart's three choices under them.
              <div className="-mt-0.5 flex flex-col gap-2 pb-3 pl-[42px] pr-3">
                <span className="text-[12.5px] leading-[1.45] text-text-bright [text-wrap:pretty]">
                  {sessionsWords.question}{' '}
                  <span className="text-[rgba(160,190,225,.7)]">{sessionsWords.body}</span>
                </span>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="quiet"
                    size="member-quiet"
                    disabled={updates.starting !== null}
                    onClick={() => setAskingUpdate(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="outline"
                    size="member"
                    disabled={updates.starting !== null}
                    onClick={() => void confirmUpdate(m.id, 'now')}
                  >
                    {UPDATE_NOW}
                  </Button>
                  <Button
                    variant="ink"
                    size="member"
                    disabled={updates.starting !== null}
                    onClick={() => void confirmUpdate(m.id, 'idle')}
                  >
                    {UPDATE_WHEN_IDLE}
                  </Button>
                </div>
              </div>
            )}
            {refusal?.id === m.id && (
              <div role="alert" className="px-4 pb-2.5 text-[12.5px] leading-[1.5] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
                {refusal.text}
              </div>
            )}
            {asking !== m.id && (
              <GrantToggles memberId={m.id} name={m.name} grants={grants[m.id]} saving={saving} onToggle={toggleGrant} />
            )}
            {saveError?.memberId === m.id && (
              <div role="alert" className="px-4 pb-2.5 text-[12.5px] leading-[1.5] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
                {saveError.text}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The one-time notice of the group's ending by the primary's hand (canvas
 * 50m): it heads IN THIS GROUP until OK, which the server forgets. No toast,
 * no badge, no sound.
 */
function EndedNotice({ ended }: { ended: GroupEnded }) {
  const [busy, setBusy] = useState(false)
  const { head, body } = endedNotice(ended, 'desktop')

  async function ok() {
    if (busy) return
    setBusy(true)
    try {
      await api.acknowledgeEnded()
      // The server publishes the status without it; this tab need not wait for the hub.
      const { remote, setRemote } = useOrbital.getState()
      if (remote) setRemote({ ...remote, group: { ...remote.group, ended: null } })
    } catch (err) {
      reportError(err, 'Failed to dismiss the notice')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-2.5 flex items-center gap-3.5 rounded-[12px] border border-[rgba(150,205,255,.2)] bg-[rgba(150,205,255,.05)] py-3.5 pl-4 pr-3">
      <span className="flex text-[rgba(232,238,248,.7)]">
        <KindGlyph kind="desktop" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="text-[13.5px] font-semibold text-text-bright">{head}</span>
        <span className="text-[12.5px] leading-[1.45] text-[rgba(160,190,225,.72)] [text-wrap:pretty]">{body}</span>
      </span>
      <Button variant="outline" size="member" disabled={busy} onClick={() => void ok()}>
        OK
      </Button>
    </div>
  )
}

/**
 * ADD A DEVICE on a member (canvas 50l, 50r): no code and no field, only who
 * adds and removes devices — on a server primary, with the command that does
 * it there — and, while the primary updates, that adding and removing waits.
 */
function Managed({ primary, kind, updating }: { primary: string; kind: string; updating: boolean }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-[12px] border border-dashed border-[rgba(150,205,255,.16)] p-4">
      <div className="flex items-start gap-3">
        <span className="flex pt-1 text-[rgba(232,238,248,.7)]">
          <KindGlyph kind={kind} />
        </span>
        <span className="flex flex-1 flex-col gap-[5px]">
          <span className="text-[12.5px] leading-[1.5] text-[rgba(200,214,235,.82)] [text-wrap:pretty]">
            <span className="font-semibold text-text-bright">{primary}</span> manages this group — add and remove devices there.
          </span>
          {/* Canvas 50r: a server primary adds and removes in its terminal. */}
          {kind === 'headless' && (
            <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">on {primary}: orbital devices</span>
          )}
        </span>
      </div>
      {updating && (
        <span className="border-t border-[rgba(150,205,255,.08)] pl-6 pt-2.5 text-[12px] leading-[1.5] text-[rgba(160,190,225,.72)] [text-wrap:pretty]">
          {primary} is updating. Adding and removing devices waits until it’s back; everything else keeps working.
        </span>
      )}
    </div>
  )
}

/**
 * Dissolve this group on the primary, Leave this group on a member (canvas
 * 50a, 50l), only while another member exists. It asks in place. While the
 * relay cannot carry it, the button dims and one line under the row says
 * why (canvas 50p F); a refusal the server answers is said in the same
 * place, never as a toast (50p I).
 */
function Leave({
  exit,
  count,
  primary,
  relayOnline,
}: {
  exit: 'dissolve' | 'leave'
  count: number
  primary: string
  relayOnline: boolean
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<'offline' | 'failed' | null>(null)
  const words = exitWords(exit, count, primary)

  // The refusal was about the relay; once it is back, it can be asked again.
  useEffect(() => {
    if (relayOnline) setRefused((r) => (r === 'offline' ? null : r))
  }, [relayOnline])

  const offline = !relayOnline || refused === 'offline'
  const line = offline ? words.offline : refused === 'failed' ? words.failed : null

  async function leave() {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.leaveGroup()
      setAsking(false)
      if (!res.ok) setRefused(res.error)
    } catch (err) {
      setAsking(false)
      reportError(err, exit === 'dissolve' ? 'Failed to dissolve the group' : 'Failed to leave the group')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 rounded-[12px] border border-[rgba(150,205,255,.12)] px-4 py-3">
      {!asking || offline ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-3">
            <span className="flex flex-1 flex-col gap-[3px]">
              <span className="text-[13px] font-semibold text-text-bright">{words.title}</span>
              <span className="text-[12px] leading-[1.45] text-[rgba(160,190,225,.7)]">{words.sub}</span>
            </span>
            <Button
              variant="outline"
              size="member"
              disabled={offline}
              onClick={() => {
                setRefused(null)
                setAsking(true)
              }}
            >
              {words.button}
            </Button>
          </div>
          {line && <span className="text-[12.5px] leading-[1.5] text-[rgba(160,190,225,.72)] [text-wrap:pretty]">{line}</span>}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <span className="text-[12.5px] leading-[1.5] text-text-bright [text-wrap:pretty]">
            {words.question} <span className="text-[rgba(160,190,225,.7)]">{words.body}</span>
          </span>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="member" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button variant="ink" size="member" disabled={busy} onClick={() => void leave()}>
              {words.go}
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

/** The 9r confirm's words for each setting. */
const ASK: Record<RelaySetting, { title: string; body: (count: number) => string }> = {
  remote_relay_url: { title: relayChangeWords(0).title, body: (count) => relayChangeWords(count).body },
  remote_relay_secret: {
    title: relayChangeWords(0, 'secret').title,
    body: (count) => relayChangeWords(count, 'secret').body,
  },
}

/**
 * Change relay (canvas 50a, 9r): the relay URL and the relay secret. Each is
 * committed on Enter or blur, never debounced — a relay change drops every
 * connection, so it must not fire mid-typing — and with devices paired a
 * change asks first, because they are removed. Only out of a group: one
 * relay serves the whole group, and moving it is not built (canvas 50a).
 * The secret's row is not on the canvas yet (ADR
 * the-relay-takes-a-shared-secret): it mirrors the URL's.
 */
function RelaySettings({
  patchAndSet,
  savedUrl,
  savedSecret,
  remote,
  proposed,
  onProposedDone,
}: {
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
  savedUrl: string
  savedSecret: string
  remote: RemoteStatus | null
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
        desc="Set it before pairing: every device that joins uses this relay. In a group it is locked until the group is gone."
      >
        <Input
          aria-label="Relay URL"
          font="mono"
          size="sm"
          spellCheck={false}
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
          {ask.body(count)}
        </p>
      </Dialog>
    </>
  )
}
