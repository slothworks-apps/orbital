import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { osName } from '@orbital/shared/remote/device'
import { kindOs, type RowState } from '../../lib/devices'
import { useNow } from '../../lib/useNow'
import { KindGlyph } from '../../ui/KindGlyph'
import { phoneRows, removalLeavesAlone, type PhoneRow } from '../devices'
import { forgetGroupHere, LEAVE_FAILED, LEAVE_OFFLINE, leaveGroup } from '../forget'
import { relayHost } from '../format'
import { thisDevice } from '../platform/device'
import { useMobile } from '../state'
import { groupRef } from '../transport/groupRef'
import { BottomSheet, CARD, PrimaryButton, SecondaryButton, SectionLabel, SheetPresence } from '../ui'

/** "asleep · seen …" moves in minutes at the finest, so the rows are re-read that often. */
const SEEN_TICK_MS = 60_000

/**
 * A member's state dot (canvas 50i, logic.js `DOT`): accent while online,
 * every other state neutral — a hollow ring asleep, a dashed one while
 * linking, a faint one while not linked; an ink dot while too old.
 */
const MEMBER_DOT: Record<Exclude<RowState, 'elsewhere'>, CSSProperties> = {
  online: { background: 'oklch(85% .12 205)' },
  offline: { border: '1.3px solid rgba(200,215,235,.6)' },
  linking: { border: '1.3px dashed rgba(200,215,235,.6)' },
  notLinked: { border: '1.3px solid rgba(200,215,235,.32)' },
  update: { background: 'rgba(232,238,248,.85)' },
}

function Dot({ state }: { state: RowState }) {
  if (state === 'elsewhere') return null
  return <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full box-border" style={MEMBER_DOT[state]} />
}

/** The relay link as REMOTE's state line says it. */
const LINK_WORDS = { online: 'online', connecting: 'connecting…', off: 'offline' } as const

/** Text-link rows of ADD A DEVICE (canvas 50i): 56 px, a chevron at the end. */
const LINK_ROW = 'flex min-h-14 w-full items-center gap-3 px-3.5 text-left text-[14px] font-semibold text-text-bright'

/** THIS PHONE, IN THIS GROUP, ADD A DEVICE, REMOTE and Leave this group (canvas 50i), at the top of Settings. */
export function DevicesSection() {
  const members = useMobile((s) => s.members)
  const devices = useMobile((s) => s.devices)
  const link = useMobile((s) => s.link)
  const pairing = useMobile((s) => s.pairing)
  const go = useMobile((s) => s.go)
  const now = useNow(true, SEEN_TICK_MS)
  const rows = useMemo(() => phoneRows(members, devices, now), [members, devices, now])
  const self = members.find((m) => m.self)
  const [device, setDevice] = useState<{ name: string; platform: string } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [relayOpen, setRelayOpen] = useState(false)

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

      <SectionLabel>IN THIS GROUP · {rows.length}</SectionLabel>
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
                <span
                  className={[
                    'truncate text-[14.5px] font-semibold',
                    row.state === 'offline' ? 'text-[rgba(232,238,248,.62)]' : 'text-text-bright',
                  ].join(' ')}
                >
                  {row.name}
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
                <span className="truncate font-mono text-[10px] text-[rgba(160,190,225,.42)]">
                  {row.kindOs} · {row.added}
                </span>
              </span>
              <span aria-hidden className="grid h-11 w-8 place-items-center text-[18px] text-[rgba(160,190,225,.5)]">
                ›
              </span>
            </button>
          ))}
        </div>
      )}

      <SectionLabel>ADD A DEVICE</SectionLabel>
      <div className={CARD}>
        <button type="button" onClick={() => go('pairing')} className={LINK_ROW}>
          <span className="flex-1">Scan another device&apos;s code</span>
          <span aria-hidden className="text-[18px] text-[rgba(160,190,225,.5)]">›</span>
        </button>
        <button type="button" onClick={() => go('code')} className={`${LINK_ROW} border-t border-[rgba(150,205,255,.08)]`}>
          <span className="flex-1">Show this phone&apos;s code</span>
          <span aria-hidden className="text-[18px] text-[rgba(160,190,225,.5)]">›</span>
        </button>
      </div>
      <p className="px-1 pt-2 text-[12px] leading-[1.5] text-[rgba(160,190,225,.65)] [text-wrap:pretty]">
        Scan the QR on a desktop&apos;s Devices page, or show a code for a desktop or server to paste.
      </p>

      <SectionLabel>REMOTE</SectionLabel>
      <div className={CARD}>
        {/* The canvas's switch is left out: the phone has nothing to show without the group. */}
        <div className="flex min-h-16 items-center gap-2.5 px-3.5">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[14px] font-semibold">Connect this phone to the group</span>
            <span className="truncate font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
              {LINK_WORDS[link]}
              {pairing ? ` · ${relayHost(pairing.relay)}` : ''}
            </span>
          </span>
        </div>
        <button
          type="button"
          aria-expanded={relayOpen}
          onClick={() => setRelayOpen(!relayOpen)}
          className="flex min-h-13 w-full items-center gap-2.5 border-t border-[rgba(150,205,255,.08)] px-3.5 text-left"
        >
          <span aria-hidden className="text-[9px] text-[rgba(160,190,225,.6)]">
            {relayOpen ? '▾' : '▸'}
          </span>
          <span className="flex-1 text-[14px] font-semibold">Relay</span>
          <span className="font-mono text-[11px] text-[rgba(160,190,225,.6)]">same for the group</span>
        </button>
        {relayOpen && (
          <p className="px-3.5 pb-3.5 text-[11.5px] leading-[1.45] text-[rgba(160,190,225,.6)]">
            {pairing ? `${relayHost(pairing.relay)}. ` : ''}Every device in the group uses the same relay. It only sees
            encrypted bytes.
          </p>
        )}
      </div>

      <div className={[CARD, 'mt-5'].join(' ')}>
        <button
          type="button"
          onClick={() => setLeaving(true)}
          className="flex min-h-13 w-full items-center px-3.5 text-left text-[14px] font-semibold text-text-bright"
        >
          Leave this group
        </button>
      </div>

      <SheetPresence>
        {sheet && (
          <DeviceSheet
            row={sheet}
            alone={removalLeavesAlone(members, devices, sheet.id)}
            onClose={() => setOpen(null)}
            onPairByHand={() => {
              setOpen(null)
              go('code')
            }}
          />
        )}
      </SheetPresence>
      <SheetPresence>{leaving && <LeaveSheet onClose={() => setLeaving(false)} />}</SheetPresence>
    </>
  )
}

/** The words of a removal the group did not take. */
function removeError(error: 'not_found' | 'offline' | 'failed'): string {
  if (error === 'offline') return LEAVE_OFFLINE
  if (error === 'not_found') return 'It is not in the group any more.'
  return "Couldn't remove it on this phone. Try again."
}

/**
 * A member's sheet (canvas 50i `pS`): its state and who added it, Pair by
 * hand, and Remove — the one confirm. `alone`: it is the last device this
 * phone reaches, so removing it is leaving the group (`leaveGroup`): the
 * phone forgets the group and opens the scanner, and its pairs go at the
 * relay before it does.
 */
function DeviceSheet({
  row, alone, onClose, onPairByHand,
}: { row: PhoneRow; alone: boolean; onClose: () => void; onPairByHand: () => void }) {
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
            <dd className="min-w-0 truncate text-text-bright">{row.added}</dd>
          </div>
        </dl>
        {row.notLinked && <PrimaryButton variant="sheet" onClick={onPairByHand}>Pair by hand</PrimaryButton>}
        <p className="text-[13px] leading-[1.5] text-[rgba(160,190,225,.72)] [text-wrap:pretty]">
          {alone
            ? `${row.name} is the last device this phone reaches. Removing it leaves the group: this phone forgets it and opens the scanner.`
            : `Removing ${row.name} drops it out of every device in the group now; it has to join again.`}
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
          Remove from group
        </button>
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
      </div>
    </BottomSheet>
  )
}

/**
 * Leaving the group: every device hears of it, then the phone forgets the
 * group and opens the scanner. Refused while the relay is not reached; then
 * the phone can still forget the group on its own, and says what that leaves.
 */
function LeaveSheet({ onClose }: { onClose: () => void }) {
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
    <BottomSheet label="Leave this group?" onDismiss={onClose} variant="device">
      <div className="flex flex-col gap-3 pb-2">
        <h2 className="pt-1.5 text-[18px] font-bold">Leave this group?</h2>
        <p className="text-[14px] leading-[1.5] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
          Every device in the group drops this phone, and this phone forgets them, then opens the scanner. Sessions keep
          running where they are.
        </p>
        {refused && (
          <p role="alert" className="text-[13px] text-[rgba(200,214,235,.85)]">
            {refused === 'offline' ? LEAVE_OFFLINE : LEAVE_FAILED}
          </p>
        )}
        <div className="mt-1.5 flex flex-col gap-3">
          <PrimaryButton variant="sheet" disabled={busy} onClick={() => void leave()}>
            Leave this group
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
              <p className="px-1 text-[12px] leading-[1.5] text-[rgba(160,190,225,.65)]">
                The other devices keep listing this phone, and may still notify it, until someone removes it there.
              </p>
            </>
          )}
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      </div>
    </BottomSheet>
  )
}
