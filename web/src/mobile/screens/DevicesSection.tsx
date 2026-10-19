import { useEffect, useMemo, useState } from 'react'
import { osName } from '@orbital/shared/remote/device'
import type { GroupEnded } from '@orbital/shared/remote/group'
import { endedNotice, kindOs, type RowState } from '../../lib/devices'
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
import { BottomSheet, CARD, SecondaryButton, SectionLabel, SheetPresence } from '../ui'
import { relayLockedLine } from '@orbital/shared/remote/groupWords'

/** "asleep · seen …" moves in minutes at the finest, so the rows are re-read that often. */
const SEEN_TICK_MS = 60_000

/** A member's state dot, 6 px on the phone (canvas 50i); none for a phone paired with another member. */
function Dot({ state }: { state: RowState }) {
  if (state === 'elsewhere') return null
  return <MemberDot state={state} sizePx={6} />
}

/** The relay link as REMOTE's state line says it. */
const LINK_WORDS = { online: 'online', connecting: 'connecting…', off: 'offline' } as const

/** Text-link rows of ADD A DEVICE (canvas 50i): 56 px, a chevron at the end. */
const LINK_ROW = 'flex min-h-14 w-full items-center gap-3 px-3.5 text-left text-[14px] font-semibold text-text-bright'

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
  const pairing = useMobile((s) => s.pairing)
  const standaloneRelay = useMobile((s) => s.standaloneRelay)
  // A standalone phone still names the relay it stays on (canvas 50n).
  const relayUrl = pairing?.relay ?? standaloneRelay
  const go = useMobile((s) => s.go)
  const pendingPair = useMobile((s) => s.pendingPair)
  const setAside = useJoinSheet((s) => s.setAside)
  const review = pendingPair && pendingPair.phone === setAside ? pendingPair : null
  const now = useNow(true, SEEN_TICK_MS)
  const rows = useMemo(() => phoneRows(members, devices, now), [members, devices, now])
  const self = members.find((m) => m.self)
  const [device, setDevice] = useState<{ name: string; platform: string } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)

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
          <span className="flex text-text-bright">
            <KindGlyph kind="phone" untitled />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[14.5px] font-semibold">{name}</span>
            <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">{kindOs('phone', os)}</span>
          </span>
        </div>
      </div>

      {ended && <EndedNotice ended={ended} />}

      {/* A Mac from before groups keeps its row here too: it is the device this phone shows. */}
      {(inGroup || rows.length > 0) && <SectionLabel>IN THIS GROUP · {rows.length}</SectionLabel>}
      {rows.length > 0 && (
        <div className={CARD}>
          {rows.map((row, i) => (
            <button
              key={row.id}
              type="button"
              onClick={() => setOpen(row.id)}
              className={[
                'flex min-h-[68px] w-full items-center gap-3.5 py-[9px] pl-3.5 pr-1.5 text-left',
                i > 0 ? 'border-t border-[rgba(150,205,255,.08)]' : '',
              ].join(' ')}
            >
              <span className={['flex', row.state === 'offline' ? 'text-[rgba(232,238,248,.62)]' : 'text-text-bright'].join(' ')}>
                <KindGlyph kind={row.kind} untitled />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={[
                      'truncate text-[14.5px] font-semibold',
                      row.state === 'offline' ? 'text-[rgba(232,238,248,.62)]' : 'text-text-bright',
                    ].join(' ')}
                  >
                    {row.name}
                  </span>
                  {row.primary && <PrimaryLabel />}
                </span>
                <span
                  className={[
                    'flex items-center gap-[7px] font-mono text-[10.5px]',
                    row.state === 'online' ? 'text-[rgba(200,220,245,.85)]' : 'text-[rgba(160,190,225,.72)]',
                  ].join(' ')}
                >
                  <Dot state={row.state} />
                  <span className="truncate">{row.words}</span>
                </span>
                <span className="truncate font-mono text-[10px] text-[rgba(160,190,225,.42)]">{row.kindOs}</span>
              </span>
              <span aria-hidden className="grid h-11 w-8 place-items-center text-[18px] text-[rgba(160,190,225,.5)]">
                ›
              </span>
            </button>
          ))}
        </div>
      )}

      {inGroup && primary && (
        <p className="px-1 pt-2.5 text-[12.5px] leading-[1.5] text-[rgba(160,190,225,.72)] [text-wrap:pretty]">
          <span className="font-semibold text-text-bright">{primary.name}</span> manages this group — add and remove devices
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
                className={`${LINK_ROW} border-b border-[rgba(150,205,255,.08)]`}
              >
                <span className="min-w-0 flex-1 truncate">{review.name} wants to join</span>
                <span className="text-accent">Review</span>
                <span aria-hidden className="text-[18px] text-[rgba(160,190,225,.5)]">›</span>
              </button>
            )}
            <button type="button" onClick={() => go('pairing')} className={LINK_ROW}>
              <span className="flex-1">Scan another device&apos;s code</span>
              <span aria-hidden className="text-[18px] text-[rgba(160,190,225,.5)]">›</span>
            </button>
            {/* Only with a client on a relay to show it from: a phone standalone after the group's ending keeps one. */}
            {(pairing || link !== 'off') && (
              <button type="button" onClick={() => go('code')} className={`${LINK_ROW} border-t border-[rgba(150,205,255,.08)]`}>
                <span className="flex-1">Show this phone&apos;s code</span>
                <span aria-hidden className="text-[18px] text-[rgba(160,190,225,.5)]">›</span>
              </button>
            )}
          </div>
          <p className="px-1 pt-2 text-[12px] leading-[1.5] text-[rgba(160,190,225,.65)] [text-wrap:pretty]">
            Scan the QR on a desktop&apos;s Devices page, or show a code for a desktop or server to paste.
          </p>
        </>
      )}

      <SectionLabel>REMOTE</SectionLabel>
      {/* Canvas 50i THE SAME LIST: REMOTE holds only the relay — no Connect switch, nothing to open. */}
      <div className={CARD}>
        <div className="flex min-h-16 items-center gap-2.5 px-3.5">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[14px] font-semibold">Relay</span>
            <span className="flex min-w-0 items-center gap-[7px] font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
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
        <p className="px-1 pt-2 text-[12px] leading-[1.5] text-[rgba(160,190,225,.65)] [text-wrap:pretty]">
          {relayLockedLine('member')}
        </p>
      )}

      {inGroup && (
        <div className={[CARD, 'mt-5'].join(' ')}>
          <button
            type="button"
            onClick={() => setLeaving(true)}
            className="flex min-h-13 w-full items-center px-3.5 text-left text-[14px] font-semibold text-text-bright"
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
    <div className="mt-3 flex flex-col gap-3 rounded-[14px] border border-[rgba(150,205,255,.2)] bg-[rgba(150,205,255,.05)] p-3.5">
      <div className="flex items-start gap-3">
        <span className="flex pt-[5px] text-[rgba(232,238,248,.7)]">
          <KindGlyph kind="desktop" untitled />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[14.5px] font-semibold">{head}</span>
          <span className="text-[13px] leading-[1.5] text-[rgba(160,190,225,.72)] [text-wrap:pretty]">{body}</span>
        </span>
      </div>
      <button
        type="button"
        onClick={ok}
        className="h-11 self-end rounded-[12px] border border-[rgba(150,205,255,.2)] px-5 text-[14px] font-semibold text-text-bright"
      >
        OK
      </button>
    </div>
  )
}

/**
 * A device's sheet (canvas 50i `pS`): its state and when it joined. In a
 * group a phone removes no one, so the sheet says who does and only closes.
 * Out of one — a Mac from before groups this phone paired with — Remove ends
 * that pair; `alone`: it is the last device this phone reaches, so removing
 * it is leaving (`leaveGroup`): the phone forgets it and opens the scanner.
 */
function DeviceSheet({
  row, primary, alone, onClose,
}: { row: PhoneRow; primary: string | null; alone: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    const group = groupRef.current?.group
    if (!group || busy) return
    setBusy(true)
    setError(null)
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

  return (
    <BottomSheet label={row.name} onDismiss={onClose} variant="device">
      <div className="flex flex-col gap-3 pb-2">
        <div className="flex items-center gap-3.5 pt-1.5">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[12px] border border-[rgba(150,205,255,.2)] text-text-bright">
            <KindGlyph kind={row.kind} scale={2} untitled />
          </span>
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="truncate text-[18px] font-bold">{row.name}</span>
            <span className="font-mono text-[11px] text-[rgba(160,190,225,.65)]">{row.kindOs}</span>
          </span>
        </div>
        <dl className="flex flex-col rounded-[14px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.5)] font-mono text-[11.5px] text-[rgba(160,190,225,.65)]">
          <div className="flex items-center gap-2 px-3.5 py-3">
            <dt className="flex-1">state</dt>
            <Dot state={row.state} />
            <dd className="min-w-0 truncate text-text-bright">{row.words}</dd>
          </div>
          <div className="flex gap-2 border-t border-[rgba(150,205,255,.08)] px-3.5 py-3">
            <dt className="flex-1">joined</dt>
            <dd className="min-w-0 truncate text-text-bright">{joinedDate(row.joinedAt)}</dd>
          </div>
        </dl>
        {primary !== null ? (
          <>
            <p className="text-[13px] leading-[1.5] text-[rgba(160,190,225,.72)] [text-wrap:pretty]">
              {row.primary
                ? `${primary} is this group’s primary. Only it adds and removes devices.`
                : `Only ${primary} can remove ${row.name} from the group.`}
            </p>
            <SecondaryButton onClick={onClose}>Close</SecondaryButton>
          </>
        ) : (
          <>
            <p className="text-[13px] leading-[1.5] text-[rgba(160,190,225,.72)] [text-wrap:pretty]">
              {alone
                ? `${row.name} is the last device this phone reaches. Removing it forgets it here and opens the scanner.`
                : `Removing ${row.name} ends this phone's pair with it.`}
            </p>
            {error && (
              <p role="alert" className="text-[13px] text-[rgba(200,214,235,.85)]">
                {error}
              </p>
            )}
            {/* The canvas's light button: a removal is no accent action. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="h-13 rounded-[14px] bg-[#e8eef8] text-[15px] font-bold text-[#05070d] disabled:opacity-40"
            >
              Remove
            </button>
            <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          </>
        )}
      </div>
    </BottomSheet>
  )
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
        <h2 className="pt-1.5 text-[18px] font-bold">Leave the group?</h2>
        <p className="text-[13px] leading-[1.5] text-[rgba(160,190,225,.72)] [text-wrap:pretty]">
          This phone becomes standalone and stops seeing the group’s sessions. To join again, pair it with {primary}.
        </p>
        {refused && (
          <p role="alert" className="text-[13px] text-[rgba(200,214,235,.85)]">
            {refused === 'offline' ? LEAVE_OFFLINE : LEAVE_FAILED}
          </p>
        )}
        <div className="flex flex-col gap-3">
          {/* The canvas's light button: leaving is no accent action. */}
          <button
            type="button"
            disabled={busy}
            onClick={() => void leave()}
            className="h-13 rounded-[14px] bg-[#e8eef8] text-[15px] font-bold text-[#05070d] disabled:opacity-40"
          >
            Leave group
          </button>
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
              <p className="px-1 text-[12px] leading-[1.5] text-[rgba(160,190,225,.65)]">
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
