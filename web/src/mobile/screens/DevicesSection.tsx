import { useEffect, useMemo, useState } from 'react'
import { osName } from '@orbital/shared/remote/device'
import type { GroupEnded } from '@orbital/shared/remote/group'
import { endedNotice, kindOs, type RowState } from '../../lib/devices'
import {
  UPDATE_UNREACHABLE, UPDATE_UNREACHABLE_CANCEL, updateRow, type MemberUpdate, type UpdateRow,
} from '../../lib/memberUpdate'
import {
  useMemberUpdates, type CancelResult, type PressResult, type UpdateIo, type UpdateTarget,
} from '../../lib/useMemberUpdates'
import { useNow } from '../../lib/useNow'
import { KindGlyph } from '../../ui/KindGlyph'
import { MemberDot } from '../../ui/MemberDot'
import { PrimaryLabel } from '../../ui/PrimaryLabel'
import { phoneRows, removalLeavesAlone, type PhoneRow } from '../devices'
import { useJoinSheet } from '../JoinRequestSheet'
import { forgetGroupHere, LEAVE_FAILED, LEAVE_OFFLINE, leaveGroup } from '../forget'
import { relayHost } from '../format'
import { thisDevice } from '../platform/device'
import { clearEnded } from '../platform/pairing'
import { useMobile } from '../state'
import { groupRef } from '../transport/groupRef'
import { BottomSheet, CARD, PrimaryButton, SecondaryButton, SectionLabel, SheetPresence } from '../ui'
import {
  CANCEL_THE_UPDATE, UPDATE_WHEN_IDLE, relayLockedLine, updateSessionsWords,
} from '@orbital/shared/remote/groupWords'
import type { UpdateWhen } from '@orbital/shared/remote/serverUpdate'
import { cancelDeviceUpdate, readDeviceUpdate, startDeviceUpdate } from '../serverUpdate'
import type { DeviceView } from '../state'
import { macSupports } from '../version'

/** "asleep · seen …" moves in minutes at the finest, so the rows are re-read that often. */
const SEEN_TICK_MS = 60_000

/** A member's state dot, 6 px on the phone (canvas 50i); none for a phone paired with another member. */
function Dot({ state }: { state: RowState | 'linking' | 'offline' }) {
  if (state === 'elsewhere') return null
  return <MemberDot state={state} sizePx={6} />
}

/**
 * The phone asks a member about its update only through `readDeviceUpdate`
 * / `startDeviceUpdate` / `cancelDeviceUpdate`, gated by
 * `MAC_FEATURES.serverUpdate`; a member is readable while its channel is up
 * (canvas 50s).
 */
const PHONE_UPDATE_IO: UpdateIo = {
  read: (id) => readDeviceUpdate(id),
  start: (id, when) => startDeviceUpdate(id, when),
  cancel: (id) => cancelDeviceUpdate(id),
}

/** Every member whose hello serves the routes; readable while its channel is up. A phone has no entry in `devices`. */
function updateTargets(rows: PhoneRow[], devices: DeviceView[]): UpdateTarget[] {
  const served = new Map(devices.filter((d) => macSupports('serverUpdate', d.version)).map((d) => [d.id, d]))
  return rows
    .filter((r) => r.kind !== 'phone' && served.has(r.id))
    .map((r) => ({ id: r.id, readable: r.state === 'online' && served.get(r.id)!.ready }))
}

/** A row as its update says it (canvas 50s `pState`, `kindOsV`). */
function rowUpdate(row: PhoneRow, u: MemberUpdate | undefined, selfId: string | null): UpdateRow {
  return updateRow(u, {
    name: row.name, kind: row.kind, online: row.state === 'online', words: row.words,
    helloVersion: row.version, selfId, surface: 'phone',
  })
}

/** The relay link as REMOTE's state line says it. */
const LINK_WORDS = { online: 'online', connecting: 'connecting…', off: 'offline' } as const

/** Text-link rows of ADD A DEVICE (canvas 50i): 56 px, a chevron at the end. */
const LINK_ROW = 'flex h-fit min-h-14 w-full items-center gap-3 px-3.5 text-left fs-14 font-semibold text-ink-100'

/** A member's join date as the sheet's `joined` says it (canvas 50i: `12 Oct`). */
function joinedDate(ts: number | null): string {
  return ts === null ? '—' : new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * THIS PHONE, IN THIS GROUP, ADD A DEVICE, REMOTE and Leave this group
 * (canvas 50i, 50n), at the top of Settings. In a group, the list and the
 * line that names its primary — which alone adds and removes devices — and
 * Leave; in none, ADD A DEVICE. The notice of the group's ending by the
 * primary's hand sits under THIS PHONE until OK.
 */
export function DevicesSection() {
  const members = useMobile((s) => s.members)
  const primary = useMobile((s) => s.group.primary)
  const ended = useMobile((s) => s.groupEnded)
  const devices = useMobile((s) => s.devices)
  const link = useMobile((s) => s.link)
  const rechecking = useMobile((s) => s.rechecking)
  const pairing = useMobile((s) => s.pairing)
  const standaloneRelay = useMobile((s) => s.standaloneRelay)
  // A standalone phone still names the relay it stays on (canvas 50n).
  const relayUrl = pairing?.relay ?? standaloneRelay
  const go = useMobile((s) => s.go)
  const pendingPair = useMobile((s) => s.pendingPair)
  const setAside = useJoinSheet((s) => s.setAside)
  const review = pendingPair && pendingPair.phone === setAside ? pendingPair : null
  const now = useNow(true, SEEN_TICK_MS)
  const rows = useMemo(() => phoneRows(members, { link, rechecking, devices }, now), [members, link, rechecking, devices, now])
  const self = members.find((m) => m.self)
  const [device, setDevice] = useState<{ name: string; platform: string; osVersion?: string } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const updates = useMemberUpdates(updateTargets(rows, devices), PHONE_UPDATE_IO)
  const selfId = self?.id ?? null

  // The name this phone gives itself (`thisDevice`), before the roster lists it.
  useEffect(() => {
    let current = true
    void thisDevice().then((d) => {
      if (current) setDevice(d)
    })
    return () => {
      current = false
    }
  }, [])

  // The open row's sheet follows the roster: a member removed meanwhile closes it.
  const sheet = rows.find((r) => r.id === open) ?? null
  const name = self?.name ?? device?.name ?? ''
  const os = self?.os ?? (device ? osName(device.platform) : '')
  // A phone is never primary: in a group, another device adds and removes (canvas 50i).
  const inGroup = primary !== null

  return (
    <>
      <SectionLabel first>THIS PHONE</SectionLabel>
      <div className={CARD}>
        {/* No ✎: each device names itself, and the group has no rename for a phone. */}
        <div className="flex min-h-16 items-center gap-3.5 px-3.5">
          <span className="flex text-ink-100">
            <KindGlyph kind="phone" untitled />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate fs-14.5 font-semibold">{name}</span>
            {/* Canvas 50s: this phone's own version, and no Update — its store updates it. */}
            <span className="font-mono fs-10.5 text-ink-900/65">
              {kindOs('phone', os, device?.osVersion)} · {__MOBILE_VERSION__}
            </span>
          </span>
        </div>
      </div>

      {ended && <EndedNotice ended={ended} />}

      {/* A Mac from before groups keeps its row here too: it is the device this phone shows. */}
      {(inGroup || rows.length > 0) && <SectionLabel>IN THIS GROUP · {rows.length}</SectionLabel>}
      {rows.length > 0 && (
        <div className={CARD}>
          {rows.map((row, i) => {
            const update = rowUpdate(row, updates.byId[row.id], selfId)
            const away = update.dim ?? row.state === 'offline'
            const nameInk = away ? 'text-ink-100/62' : 'text-ink-100'
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => setOpen(row.id)}
                className={[
                  'flex min-h-[68px] w-full items-center gap-3.5 py-[9px] pl-3.5 pr-1.5 text-left',
                  i > 0 ? 'border-t border-line/8' : '',
                ].join(' ')}
              >
                <span className={['flex', nameInk].join(' ')}>
                  <KindGlyph kind={row.kind} untitled />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={['truncate fs-14.5 font-semibold', nameInk].join(' ')}>{row.name}</span>
                    {row.primary && <PrimaryLabel />}
                  </span>
                  <span
                    className={[
                      'flex items-center gap-[7px] font-mono fs-10.5',
                      !away && (row.state === 'online' || update.dim === false)
                        ? 'text-ink-500/85'
                        : 'text-ink-900/72',
                    ].join(' ')}
                  >
                    <Dot state={update.dot ?? row.state} />
                    <span className="truncate">{update.words}</span>
                  </span>
                  {/* Canvas 50s: the version at the end of the kind · OS line. */}
                  <span className="truncate font-mono fs-10 text-ink-900/42">
                    {row.kindOs}
                    {update.version ? ` · ${update.version}` : ''}
                  </span>
                </span>
                <span aria-hidden className="grid h-11 w-8 place-items-center fs-18 text-ink-900/50">
                  ›
                </span>
              </button>
            )
          })}
        </div>
      )}

      {inGroup && primary && (
        <p className="px-1 pt-2.5 fs-12.5 leading-[1.5] text-ink-900/72 [text-wrap:pretty]">
          <span className="font-semibold text-ink-100">{primary.name}</span> manages this group — add and remove devices
          there.
        </p>
      )}

      {/* Only in no group (canvas 50n ALONE): in one, only its primary adds a device. */}
      {!inGroup && (
        <>
          <SectionLabel>ADD A DEVICE</SectionLabel>
          <div className={CARD}>
            {review && (
              // Not on the canvas: the way back to a join request whose sheet was
              // put away (`useJoinSheet`), in ADD A DEVICE's row style.
              <button
                type="button"
                onClick={() => useJoinSheet.setState({ setAside: null })}
                className={`${LINK_ROW} border-b border-line/8`}
              >
                <span className="min-w-0 flex-1 truncate">{review.name} wants to join</span>
                <span className="text-accent">Review</span>
                <span aria-hidden className="fs-18 text-ink-900/50">›</span>
              </button>
            )}
            <button type="button" onClick={() => go('pairing')} className={LINK_ROW}>
              <span className="flex-1">Scan another device&apos;s code</span>
              <span aria-hidden className="fs-18 text-ink-900/50">›</span>
            </button>
            {/* Only with a client on a relay to show it from: a phone standalone after the group's ending keeps one. */}
            {(pairing || link !== 'off') && (
              <button type="button" onClick={() => go('code')} className={`${LINK_ROW} border-t border-line/8`}>
                <span className="flex-1">Show this phone&apos;s code</span>
                <span aria-hidden className="fs-18 text-ink-900/50">›</span>
              </button>
            )}
          </div>
          <p className="px-1 pt-2 fs-12 leading-[1.5] text-ink-900/65 [text-wrap:pretty]">
            Scan the QR on a desktop&apos;s Devices page, or show a code for a desktop or server to paste.
          </p>
        </>
      )}

      <SectionLabel>REMOTE</SectionLabel>
      {/* Canvas 50i THE SAME LIST: REMOTE holds only the relay — no Connect switch, nothing to open. */}
      <div className={CARD}>
        <div className="flex min-h-16 items-center gap-2.5 px-3.5">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="fs-14 font-semibold">Relay</span>
            <span className="flex min-w-0 items-center gap-[7px] font-mono fs-10.5 text-ink-900/65">
              <MemberDot state={link === 'online' ? 'online' : 'offline'} sizePx={6} />
              <span className="truncate">
                {LINK_WORDS[link]}
                {relayUrl ? ` · ${relayHost(relayUrl)}` : ''}
              </span>
            </span>
          </span>
        </div>
      </div>
      {inGroup && (
        <p className="px-1 pt-2 fs-12 leading-[1.5] text-ink-900/65 [text-wrap:pretty]">
          {relayLockedLine('member')}
        </p>
      )}

      {inGroup && (
        <div className={[CARD, 'mt-5'].join(' ')}>
          <button
            type="button"
            onClick={() => setLeaving(true)}
            className="flex h-fit min-h-13 w-full items-center px-3.5 text-left fs-14 font-semibold text-ink-100"
          >
            Leave this group
          </button>
        </div>
      )}

      <SheetPresence>
        {sheet && (
          <DeviceSheet
            row={sheet}
            primary={primary?.name ?? null}
            alone={removalLeavesAlone(members, devices, sheet.id)}
            onClose={() => setOpen(null)}
            update={updates.byId[sheet.id]}
            shown={rowUpdate(sheet, updates.byId[sheet.id], selfId)}
            starting={updates.starting !== null}
            onPress={() => updates.press(sheet.id)}
            onConfirm={(when) => updates.start(sheet.id, when)}
            onCancelUpdate={() => updates.cancel(sheet.id)}
          />
        )}
      </SheetPresence>
      <SheetPresence>{leaving && <LeaveSheet primary={primary?.name ?? ''} onClose={() => setLeaving(false)} />}</SheetPresence>
    </>
  )
}

/** The words of a removal the group did not take. */
function removeError(error: 'not_found' | 'offline' | 'failed' | 'not_primary'): string {
  if (error === 'offline') return LEAVE_OFFLINE
  if (error === 'not_primary') return 'Only the group’s primary removes a device.'
  if (error === 'not_found') return 'It is not in the group any more.'
  return "Couldn't remove it on this phone. Try again."
}

/**
 * The notice of the group's ending by the primary's hand (canvas 50n): under
 * THIS PHONE until OK, which forgets it here. No toast, no badge, no sound.
 */
function EndedNotice({ ended }: { ended: GroupEnded }) {
  const { head, body } = endedNotice(ended, 'phone')
  const ok = () => {
    useMobile.setState({ groupEnded: null })
    void clearEnded().catch((err: unknown) => console.warn('[mobile] could not forget the notice', err))
  }
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-[14px] border border-line/20 bg-line/5 p-3.5">
      <div className="flex items-start gap-3">
        <span className="flex pt-[5px] text-ink-100/70">
          <KindGlyph kind="desktop" untitled />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="fs-14.5 font-semibold">{head}</span>
          <span className="fs-13 leading-[1.5] text-ink-900/72 [text-wrap:pretty]">{body}</span>
        </span>
      </div>
      <button
        type="button"
        onClick={ok}
        className="h-11 self-end rounded-[12px] border border-line/20 px-5 fs-14 font-semibold text-ink-100"
      >
        OK
      </button>
    </div>
  )
}

/**
 * A device's sheet (canvas 50i `pS`, 50s): its state, its version and when
 * it joined. A member's update follows the table in the words of the
 * desktop's line, with Update, Try again or Cancel the update (a wait for
 * its sessions) only while it can be asked; with sessions running there,
 * Update asks in place first, with the three choices. The sheet stays open
 * while it updates, and Close never cancels an update. In a group a phone
 * removes no one, so the sheet says who does and only closes. Out of one —
 * a Mac from before groups this phone paired with — Remove ends that pair;
 * `alone`: it is the last device this phone reaches, so removing it is
 * leaving (`leaveGroup`): the phone forgets it and opens the scanner.
 */
function DeviceSheet({
  row, primary, alone, onClose, update, shown, starting, onPress, onConfirm, onCancelUpdate,
}: {
  row: PhoneRow
  primary: string | null
  alone: boolean
  onClose: () => void
  update: MemberUpdate | undefined
  shown: UpdateRow
  starting: boolean
  /** Update or Try again: reads the member again and starts, or asks for the confirm (`press`). */
  onPress: () => Promise<PressResult>
  /** The confirm's Update now or Update when sessions finish; `confirm` when Update now must ask again, with the count read now. */
  onConfirm: (when: UpdateWhen) => Promise<PressResult>
  /** Cancel the update: ends a wait for the sessions there, with no confirm. */
  onCancelUpdate: () => Promise<CancelResult>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A press that could not reach the member, said under the update's words. */
  const [updateError, setUpdateError] = useState<string | null>(null)
  /** The confirm, with the count it first named; `recount` once Update now found more (canvas 50t). */
  const [confirming, setConfirmingState] = useState<{ shown: number; recount: boolean } | null>(null)
  const setConfirming = (on: boolean) =>
    setConfirmingState(on ? { shown: update?.state?.sessions ?? 0, recount: false } : null)
  const line = shown.line

  /** Any new action on the sheet clears what the last one said, whichever it was. */
  const clearLines = () => {
    setError(null)
    setUpdateError(null)
  }

  const remove = async () => {
    const group = groupRef.current?.group
    if (!group || busy) return
    setBusy(true)
    clearLines()
    try {
      if (alone) {
        const left = await leaveGroup()
        if ('error' in left) setError(left.error === 'offline' ? LEAVE_OFFLINE : LEAVE_FAILED)
        return
      }
      const res = await group.remove(row.id)
      if ('error' in res) setError(removeError(res.error))
      else onClose()
    } finally {
      setBusy(false)
    }
  }

  const pressUpdate = async () => {
    clearLines()
    const result = await onPress()
    if (result === 'confirm') setConfirming(true)
    else if (result === 'unreachable') setUpdateError(UPDATE_UNREACHABLE)
  }

  const confirmUpdate = async (when: UpdateWhen) => {
    clearLines()
    const result = await onConfirm(when)
    // More sessions there than it named: it stays, naming the new count and how many are new.
    if (result === 'confirm') {
      setConfirmingState((c) => (c ? { ...c, recount: true } : c))
      return
    }
    setConfirming(false)
    if (result === 'unreachable') setUpdateError(UPDATE_UNREACHABLE)
  }

  const cancelUpdate = async () => {
    clearLines()
    if ((await onCancelUpdate()) === 'unreachable') setUpdateError(UPDATE_UNREACHABLE_CANCEL)
  }

  const sessions = updateSessionsWords(
    update?.state?.sessions ?? 0, row.name, confirming?.recount ? confirming.shown : undefined,
  )

  return (
    <BottomSheet label={row.name} onDismiss={onClose} variant="device">
      <div className="flex flex-col gap-3 pb-2">
        <div className="flex items-center gap-3.5 pt-1.5">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[12px] border border-line/20 text-ink-100">
            <KindGlyph kind={row.kind} scale={2} untitled />
          </span>
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate fs-18 font-bold">{row.name}</span>
              {row.primary && <PrimaryLabel />}
            </span>
            <span className="font-mono fs-11 text-ink-900/65">{row.kindOs}</span>
          </span>
        </div>
        <dl className="flex flex-col rounded-[14px] border border-line/12 bg-shade/50 font-mono fs-11.5 text-ink-900/65">
          <div className="flex items-center gap-2 px-3.5 py-3">
            <dt className="flex-1">state</dt>
            <Dot state={shown.dot ?? row.state} />
            {/* Canvas 50s: the sheet's state is the desktop's word (`updating`), the row's longer line is the list's. */}
            <dd className="min-w-0 truncate text-ink-100">{sheetState(shown, row)}</dd>
          </div>
          {shown.version && (
            <div className="flex gap-2 border-t border-line/8 px-3.5 py-3">
              <dt className="flex-1">version</dt>
              <dd className="min-w-0 truncate text-ink-100">{shown.version}</dd>
            </div>
          )}
          <div className="flex gap-2 border-t border-line/8 px-3.5 py-3">
            <dt className="flex-1">joined</dt>
            <dd className="min-w-0 truncate text-ink-100">{joinedDate(row.joinedAt)}</dd>
          </div>
        </dl>
        {confirming ? (
          <>
            <div className="flex flex-col gap-1 px-1 pt-0.5">
              <span className="fs-15 font-bold text-ink-100">{sessions.question}</span>
              <span className="fs-13 leading-[1.5] text-ink-900/72">{sessions.body}</span>
            </div>
            {/* Canvas 50s: the safe choice is the light, filled one; an update is no accent action. */}
            <PrimaryButton tone="light" disabled={starting} onClick={() => void confirmUpdate('idle')}>
              {UPDATE_WHEN_IDLE}
            </PrimaryButton>
            <SecondaryButton disabled={starting} onClick={() => void confirmUpdate('now')}>
              Update {row.name} now
            </SecondaryButton>
            <SecondaryButton disabled={starting} onClick={() => setConfirming(false)}>Cancel</SecondaryButton>
          </>
        ) : (
          <>
            {line && (
              <>
                <div className="flex flex-col gap-1 px-1 pt-0.5">
                  <span className="fs-14 font-semibold text-ink-100">{line.head}</span>
                  {line.sub && (
                    <span className="font-mono fs-11 leading-[1.5] text-ink-900/65">{line.sub}</span>
                  )}
                </div>
                {updateError && (
                  <p role="alert" className="fs-13 text-ink-600/85">
                    {updateError}
                  </p>
                )}
                {line.action && (
                  <SecondaryButton
                    disabled={starting}
                    onClick={() => void (line.action === 'cancel' ? cancelUpdate() : pressUpdate())}
                  >
                    {line.action === 'retry' ? 'Try again' : line.action === 'cancel' ? CANCEL_THE_UPDATE : `Update ${row.name}`}
                  </SecondaryButton>
                )}
              </>
            )}
            {primary !== null ? (
              <>
                {/* Canvas 50s: with an update to say, the sheet says that instead of who removes devices. */}
                {!line && (
                  <p className="fs-13 leading-[1.5] text-ink-900/72 [text-wrap:pretty]">
                    {row.primary
                      ? `${primary} is this group’s primary. Only it adds and removes devices.`
                      : `Only ${primary} can remove ${row.name} from the group.`}
                  </p>
                )}
                {/* Close never cancels an update: it only puts the sheet away. */}
                <SecondaryButton onClick={onClose}>Close</SecondaryButton>
              </>
            ) : (
              <>
                <p className="fs-13 leading-[1.5] text-ink-900/72 [text-wrap:pretty]">
                  {alone
                    ? `${row.name} is the last device this phone reaches. Removing it forgets it here and opens the scanner.`
                    : `Removing ${row.name} ends this phone's pair with it.`}
                </p>
                {error && (
                  <p role="alert" className="fs-13 text-ink-600/85">
                    {error}
                  </p>
                )}
                {/* The canvas's light button: a removal is no accent action. */}
                <PrimaryButton tone="light" disabled={busy} onClick={() => void remove()}>
                  Remove
                </PrimaryButton>
                <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
              </>
            )}
          </>
        )}
      </div>
    </BottomSheet>
  )
}

/**
 * The sheet's state cell (canvas 50s `pv.s.stText`): `updating` while it
 * updates, `offline` after the wait ran out, else the row's own words.
 */
function sheetState(shown: UpdateRow, row: PhoneRow): string {
  if (shown.phase === 'installing' || shown.phase === 'restarting') return 'updating'
  if (shown.phase === 'timeout') return 'offline'
  return row.words
}

/**
 * Leaving the group: every device hears of it, then the phone forgets the
 * group and opens the scanner. Refused while the relay is not reached; then
 * the phone can still forget the group on its own, and says what that leaves.
 */
function LeaveSheet({ primary, onClose }: { primary: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<'offline' | 'failed' | null>(null)

  const leave = async () => {
    if (busy) return
    setBusy(true)
    setRefused(null)
    try {
      const left = await leaveGroup()
      if ('error' in left) setRefused(left.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet label="Leave the group?" onDismiss={onClose} variant="device">
      <div className="flex flex-col gap-3 pb-2">
        <h2 className="pt-1.5 fs-18 font-bold">Leave the group?</h2>
        <p className="fs-13 leading-[1.5] text-ink-900/72 [text-wrap:pretty]">
          This phone becomes standalone and stops seeing the group’s sessions. To join again, pair it with {primary}.
        </p>
        {refused && (
          <p role="alert" className="fs-13 text-ink-600/85">
            {refused === 'offline' ? LEAVE_OFFLINE : LEAVE_FAILED}
          </p>
        )}
        <div className="flex flex-col gap-3">
          {/* The canvas's light button: leaving is no accent action. */}
          <PrimaryButton tone="light" disabled={busy} onClick={() => void leave()}>
            Leave group
          </PrimaryButton>
          {refused === 'offline' && (
            <>
              <SecondaryButton
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void forgetGroupHere()
                }}
              >
                Forget this group on this phone
              </SecondaryButton>
              <p className="px-1 fs-12 leading-[1.5] text-ink-900/65">
                The group keeps listing this phone, and may still notify it, until its primary device removes it.
              </p>
            </>
          )}
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      </div>
    </BottomSheet>
  )
}
