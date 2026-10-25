import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { timeAgo } from '../../lib/format'
import { toggleTag } from '../../lib/tagFilter'
import { isReadOnly, tagColor, type ApiSession, type Tag } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { ClaudeDirMark, useClaudeDirMark } from '../../ui/ClaudeDirMark'
import { useOrbital } from '../../store/store'
import { KindGlyph } from '../../ui/KindGlyph'
import { LimitsGlyph } from '../../ui/LimitsGlyph'
import { devicesOn, namesShown, showDeviceRow, toggleDevice } from '../../lib/devices'
import { asleepCards, onDevices, phoneChips, useDeviceFilter, type AsleepCard, type PhoneChip } from '../deviceList'
import { recheckMac } from '../connect'
import { forgetGroupHere } from '../forget'
import { CLOCK_TICK_MS, RETRY_WINDOW_MS } from '../constants'
import { agoLabel, asOfLabel, basename, checkedLabel } from '../format'
import {
  GROUP_LABEL, endedHeading, primaryTag, groupSessions, inputReason, isGateRow, limitLine, moonsSummary, moonsSummaryAsleep, subagentStatus, tagChips,
  taskStatus, tasksForRow, type GroupKey,
} from '../sessionList'
import { countedBySummary, loadEndedFold } from '../endedFold'
import { isMacAsleep, useMobile } from '../state'
import { anySupports } from '../version'
import { opensTask } from '../subagents/model'
import { MobileScreen, PrimaryButton } from '../ui'
import { WhereLine } from '../where/WhereLine'
import { PlanetGlyph } from './Glyph'
import { usePhoneNotificationsTip } from '../NotificationsTip'
import { PinnedNoticeHost } from '../PinnedNotice'
import { usePhoneWhatsNew } from '../WhatsNew'

/** 9a, updated by 10a (spec 2026-10-05-mobile-next-design): the sessions, grouped by what they need from you. */
export function SessionListScreen() {
  const sessions = useOrbital(
    useShallow((s) => s.order.map((id) => s.sessions[id]).filter((x): x is ApiSession => x !== undefined)),
  )
  const tags = useOrbital((s) => s.tags)
  const { offline, link, macName, macVersion, asOf, checkedAt, devices, rechecking } = useMobile(
    useShallow((s) => ({
      offline: isMacAsleep(s), link: s.link, macName: s.macName, macVersion: s.macVersion, asOf: s.asOf, checkedAt: s.checkedAt,
      devices: s.devices, rechecking: s.rechecking,
    })),
  )
  const hiddenDevices = useDeviceFilter((s) => s.hidden)
  const setHiddenDevices = useDeviceFilter((s) => s.setHidden)
  const unreachable = useMobile((s) => s.unreachable)
  const openSession = useMobile((s) => s.openSession)
  const openSubagent = useMobile((s) => s.openSubagent)
  const openTask = useMobile((s) => s.openTask)
  const go = useMobile((s) => s.go)
  const [tagIds, setTagIds] = useState<number[]>([])
  const [endedOpen, setEndedOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const now = useNow(true, CLOCK_TICK_MS)
  // The notifications tip, queued once after pairing (spec
  // 2026-10-08-notifications-off-by-default-design § 5).
  usePhoneNotificationsTip()
  // WHAT'S NEW after the app version changed (spec 2026-10-19-whats-new-design § The phone).
  usePhoneWhatsNew()

  const endedFold = useMobile(useShallow((s) => ({ summary: s.endedSummary, loaded: s.endedLoaded })))

  const mac = macName ?? 'Your Mac'
  // Canvas 50j: a chip per device that hosts sessions, once there are two;
  // with one, the list is 9a's, the Mac named in the header.
  const deviceChips = useMemo(() => phoneChips({ link, rechecking, devices }, sessions), [link, rechecking, devices, sessions])
  const several = showDeviceRow(deviceChips)
  const on = useMemo(() => devicesOn(deviceChips, hiddenDevices), [deviceChips, hiddenDevices])
  const withNames = namesShown(deviceChips, hiddenDevices)
  const shown = useMemo(() => (several ? onDevices(sessions, deviceChips, on) : sessions), [several, sessions, deviceChips, on])
  const asleepIds = useMemo(() => new Set(deviceChips.filter((c) => c.offline).map((c) => c.id)), [deviceChips])
  const cards = several ? asleepCards({ link, rechecking, devices }, deviceChips, on, now) : []
  /** In a group, a session's device asleep: its row dimmed and still, dated by when the device last sent. */
  const rowAsleep = (s: ApiSession) => several && s.machine !== undefined && asleepIds.has(s.machine.id)
  // In a group every row keeps its own device's state, even with every device asleep (canvas 50j).
  const listOffline = offline && !several
  const held = useMemo(() => groupSessions(shown, tagIds), [shown, tagIds])
  // The fold's unread count is the whole group's: with a device chip off as with a tag chip on, it is not shown.
  const filtered = tagIds.length > 0 || (several && on.length < deviceChips.length)
  const heading = endedHeading(held.find((g) => g.key === 'ended')?.sessions ?? [], endedFold, countedBySummary, filtered)
  // The fold is drawn from the Mac's count even before a single ended row is held.
  const groups = heading && !held.some((g) => g.key === 'ended') ? [...held, { key: 'ended' as const, sessions: [] }] : held
  const chips = useMemo(() => tagChips(shown, tags), [shown, tags])

  // One bounded presence check, never a loop (spec § 5, RETRY_WINDOW_MS).
  const retry = async () => {
    setChecking(true)
    await recheckMac(RETRY_WINDOW_MS)
    setChecking(false)
  }

  const header = (
    <>
      <div className="flex h-13 items-center gap-2.5 pl-5 pr-2">
        <OrbitalMark />
        <span className="text-[13px] font-bold tracking-[0.22em]">ORBITAL</span>
        {/* Canvas 50j: in a group the header names no one Mac; the chips say who is up. */}
        <span className="flex h-11 min-w-0 flex-1 items-center justify-end gap-[7px] px-2.5 font-mono text-[11.5px] text-[rgba(220,235,255,.85)]">
          {!several && (
            <>
              <MacDot state={offline ? 'asleep' : link === 'online' ? 'online' : 'connecting'} />
              <span className={['truncate', offline ? 'text-[rgba(200,215,235,.65)]' : ''].join(' ')}>{mac}</span>
            </>
          )}
        </span>
        {/* 60d: the Limits ring, between the Mac and Settings — the desktop shortcut's ¾ ring, never a state;
            left out while no device of the group serves the limits (`MAC_FEATURES.limitsRoutes`). */}
        {anySupports('limitsRoutes', devices, macVersion) && (
          <button
            type="button"
            aria-label="Limits"
            onClick={() => go('limits')}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] text-[rgba(214,230,248,.85)]"
          >
            <LimitsGlyph size="phone" />
          </button>
        )}
        <button type="button" aria-label="Settings" onClick={() => go('settings')} className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px]">
          <span aria-hidden className="block h-4 w-4 rounded-full border-[1.5px] border-dashed border-[oklch(85%_.12_205)]" />
        </button>
      </div>

      {several && (
        // Canvas 50j CHIP ROW PER DEVICE: above the tag chips; the last chip on stays on.
        <div className={['flex gap-2 overflow-x-auto px-4 pt-1 [scrollbar-width:none]', chips.length > 0 ? '' : 'pb-2.5'].join(' ')}>
          {deviceChips.map((chip) => (
            <DeviceChipButton
              key={chip.id}
              chip={chip}
              on={on.includes(chip.id)}
              onClick={() => setHiddenDevices(toggleDevice(hiddenDevices, chip.id, deviceChips))}
            />
          ))}
        </div>
      )}

      {chips.length > 0 && (
        <div className={['flex gap-2 overflow-x-auto pb-2.5 pl-4 [scrollbar-width:none]', several ? 'pt-2' : 'pt-1'].join(' ')}>
          {chips.map(({ tag, live }) => (
            <Chip
              key={tag.id}
              active={tagIds.includes(tag.id)}
              onClick={() => setTagIds(toggleTag(tagIds, tag.id))}
              label={tag.name}
              count={live}
              hue={tag.hue}
            />
          ))}
          {/* Canvas `Feature - Tag chips` 80b: no All; Clear ends the row while a tag is on, pinned to the
              right edge over a fade so it never scrolls out of sight. The pin stays as the row's end padding. */}
          <div className="sticky right-0 flex flex-none bg-[linear-gradient(90deg,rgba(5,7,13,0),#05070d_14px)] pl-[18px] pr-4">
            {tagIds.length > 0 && <Chip active={false} muted onClick={() => setTagIds([])} label="Clear" />}
          </div>
        </div>
      )}

      {offline && !several && (
        <section className="mx-3 mb-2.5 mt-0.5 flex items-start gap-3 rounded-[16px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.82)] py-3 pl-4 pr-3">
          <span aria-hidden className="mt-1 block h-3 w-3 shrink-0 rounded-full border-[1.5px] border-[rgba(200,215,235,.6)]" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[14.5px] font-semibold">{mac} is asleep</span>
            <span className="text-[12.5px] leading-[1.45] text-[rgba(160,190,225,.75)]">
              Showing what it last sent. Reconnects on its own when the Mac wakes.
            </span>
            <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
              {[asOf !== null ? asOfLabel(asOf, now) : null, checkedAt !== null ? checkedLabel(checkedAt, now) : null]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          <button
            type="button"
            disabled={checking}
            onClick={() => void retry()}
            className="h-11 shrink-0 rounded-[12px] border border-[rgba(150,205,255,.2)] px-3.5 text-[13px] font-semibold text-text-bright disabled:opacity-40"
          >
            Retry
          </button>
        </section>
      )}
      {/* Pinned above the list, not scrolling with it (canvas `Feature - Notice toast` 2a). */}
      <PinnedNoticeHost />
    </>
  )

  // 9a: the one action, pinned under the list; inert while the Mac is asleep.
  const footer = (
    <div className="border-t border-[rgba(150,205,255,.08)] bg-[linear-gradient(180deg,transparent,rgba(5,7,13,.95)_30%)] px-4 pb-1.5 pt-2.5">
      {offline ? (
        <div
          aria-disabled="true"
          className="flex h-13 items-center justify-center rounded-[14px] border border-[rgba(150,205,255,.14)] px-4 text-center text-[14px] font-semibold text-[rgba(160,190,225,.6)]"
        >
          {several ? 'New session · needs a device awake' : `New session · needs ${mac} awake`}
        </div>
      ) : (
        <PrimaryButton onClick={() => go('new')}>
          <span aria-hidden className="text-[20px] font-medium leading-none">
            +
          </span>
          New session
        </PrimaryButton>
      )}
    </div>
  )

  return (
    <MobileScreen header={header} footer={footer} divider={false} glow>
      <div className="pb-3">
        {unreachable && <UnreachableCard />}
        {cards.map((card) => (
          <AsleepDeviceCard key={card.id} card={card} checking={checking} onRetry={() => void retry()} />
        ))}
        {groups.map((group) => {
          if (group.key === 'ended') {
            const latest = heading?.latest ?? null
            return (
              <section key="ended">
                <button
                  type="button"
                  aria-expanded={endedOpen}
                  onClick={() => {
                    // Read from the Mac the first time it opens (`loadEndedFold`).
                    if (!endedOpen) void loadEndedFold()
                    setEndedOpen(!endedOpen)
                  }}
                  className="mx-3 mt-2.5 flex h-12 w-[calc(100%-24px)] items-center gap-2.5 rounded-[12px] px-2 text-left font-mono text-[10.5px] tracking-[0.16em] text-[rgba(160,190,225,.6)]"
                >
                  <span aria-hidden className="text-[9px]">
                    {endedOpen ? '▾' : '▸'}
                  </span>
                  <span aria-hidden className="block h-2 w-2 rounded-full border border-[rgba(200,215,235,.45)]" />
                  <span>
                    {GROUP_LABEL.ended}
                    {heading?.count != null && <> · {heading.count}</>}
                  </span>
                  {latest !== null && (
                    <span className="ml-auto tracking-[0.04em] text-[rgba(160,190,225,.45)]">latest {agoLabel(latest, now)}</span>
                  )}
                </button>
                {endedOpen && group.sessions.map((s) => <EndedRow key={s.id} session={s} tag={primaryTag(s.tagIds, tags)} device={withNames ? s.machine?.name : undefined} now={now} onOpen={openSession} />)}
              </section>
            )
          }
          if (group.key === 'pinned') {
            // Canvas 10a: headless, above the ENDED fold until unpinned.
            return (
              <section key="pinned" className="mt-1.5">
                {group.sessions.map((s) => (
                  <EndedRow key={s.id} session={s} tag={primaryTag(s.tagIds, tags)} device={withNames ? s.machine?.name : undefined} now={now} onOpen={openSession} pinned />
                ))}
              </section>
            )
          }
          const rows = group.sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              tag={primaryTag(s.tagIds, tags)}
              group={group.key}
              offline={listOffline}
              asleep={rowAsleep(s)}
              device={withNames ? s.machine?.name : undefined}
              mac={s.machine?.name || mac}
              now={now}
              onOpen={openSession}
              onOpenSubagent={openSubagent}
              onOpenTask={openTask}
            />
          ))
          const label = (
            <>
              {GROUP_LABEL[group.key]} · {group.sessions.length}
              {listOffline && <span className="tracking-[0.06em] text-[rgba(160,190,225,.45)]"> · last known</span>}
            </>
          )
          if (group.key === 'input') {
            return (
              <section
                key="input"
                className={[
                  'mx-3 mb-1.5 overflow-hidden rounded-[18px] border',
                  listOffline
                    ? 'border-[rgba(255,187,123,.28)] bg-[rgba(255,187,123,.04)]'
                    : 'border-[rgba(255,187,123,.42)] bg-[linear-gradient(180deg,rgba(255,187,123,.09),rgba(255,187,123,.02))] shadow-[0_0_30px_rgba(255,187,123,.06)]',
                ].join(' ')}
              >
                <div className="flex items-center gap-2 px-4 pb-0.5 pt-3 font-mono text-[10.5px] tracking-[0.16em] text-[var(--state-input)]">
                  <span aria-hidden className={['block h-1.5 w-1.5 rounded-full bg-[var(--state-input)]', listOffline ? '' : 'orbital-breathe'].join(' ')} />
                  {label}
                </div>
                {rows}
                {listOffline && (
                  <p className="pb-3 pl-[70px] pr-4 text-[12px] leading-[1.4] text-[rgba(160,190,225,.6)]">
                    Readable, gates and cards included; answering waits for the Mac.
                  </p>
                )}
              </section>
            )
          }
          return (
            <section key={group.key}>
              <div className="px-5 pb-0.5 pt-3.5 font-mono text-[10.5px] tracking-[0.16em] text-[rgba(160,190,225,.6)]">{label}</div>
              {rows}
            </section>
          )
        })}

        {groups.length === 0 && (
          <p className="px-8 py-10 text-center text-[13px] text-[rgba(160,190,225,.6)]">
            {tagIds.length === 0 ? 'No sessions yet.' : `No live sessions with the selected tags.`}
          </p>
        )}
      </div>
    </MobileScreen>
  )
}

/** 9a's mark beside ORBITAL: a lit ring with its moon. */
function OrbitalMark() {
  return (
    <span
      aria-hidden
      className="relative block h-4 w-4 shrink-0 rounded-full border-[1.5px] border-[oklch(85%_.12_205)] shadow-[0_0_10px_oklch(85%_.12_205/.5)]"
    >
      <span className="absolute -right-px -top-px block h-[5px] w-[5px] rounded-full bg-[oklch(85%_.12_205)]" />
    </span>
  )
}

/** The Mac's presence beside its name: lit online, hollow asleep, dim while the relay link comes up. */
function MacDot({ state }: { state: 'online' | 'asleep' | 'connecting' }) {
  if (state === 'asleep') {
    return <span role="img" aria-label="asleep" className="block h-[7px] w-[7px] shrink-0 rounded-full border-[1.2px] border-[rgba(200,215,235,.6)]" />
  }
  return (
    <span
      role="img"
      aria-label={state === 'online' ? 'online' : 'connecting to the relay'}
      className={[
        'block h-[7px] w-[7px] shrink-0 rounded-full bg-[oklch(85%_.12_205)]',
        state === 'online' ? 'shadow-[0_0_8px_oklch(85%_.12_205)]' : 'opacity-40',
      ].join(' ')}
    />
  )
}

function Chip({
  active,
  onClick,
  label,
  count,
  hue,
  muted = false,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
  hue?: number
  /** Muted ink: Clear, the one chip that is not a tag (80b). */
  muted?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'flex h-9 shrink-0 items-center gap-[7px] rounded-full border px-[13px] text-[13px] font-semibold',
        active
          ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
          : muted
            ? 'border-[rgba(150,205,255,.14)] text-[rgba(160,190,225,.6)]'
            : 'border-[rgba(150,205,255,.14)] text-[rgba(200,220,245,.75)]',
      ].join(' ')}
    >
      {hue !== undefined && <span aria-hidden className="block h-1.5 w-1.5 rounded-full" style={{ background: tagColor(hue) }} />}
      <span>{label}</span>
      {count !== undefined && <span className="font-mono text-[10.5px] font-normal text-[rgba(160,190,225,.6)]">{count}</span>}
    </button>
  )
}

/**
 * A device's chip (canvas 50j `jChips`): glyph, name, `update` for an
 * Orbital too old for this app, and how many sessions it holds; half
 * opacity while the device is asleep.
 */
function DeviceChipButton({ chip, on, onClick }: { chip: PhoneChip; on: boolean; onClick: () => void }) {
  const state = chip.update ? 'update' : chip.offline ? 'asleep' : 'online'
  return (
    <button
      type="button"
      aria-pressed={on}
      title={`${chip.name} · ${chip.kind} · ${state}`}
      onClick={onClick}
      className={[
        'flex h-9 shrink-0 items-center gap-[7px] rounded-full border px-3 text-[13px] font-semibold',
        on ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright' : 'border-[rgba(150,205,255,.14)] text-[rgba(160,190,225,.6)]',
        chip.offline ? 'opacity-50' : '',
      ].join(' ')}
    >
      <KindGlyph kind={chip.kind} untitled />
      <span>{chip.label}</span>
      {chip.update && <span className="font-mono text-[10px] font-normal text-[rgba(160,190,225,.75)]">update</span>}
      <span className="font-mono text-[10.5px] font-normal text-[rgba(160,190,225,.6)]">{chip.count}</span>
    </button>
  )
}

/** One asleep device in a group (canvas 50j ASLEEP, PER DEVICE): its rows stay below, dimmed. */
function AsleepDeviceCard({ card, checking, onRetry }: { card: AsleepCard; checking: boolean; onRetry: () => void }) {
  return (
    <section className="mx-3 mb-2 flex items-center gap-3 rounded-[14px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.82)] py-1.5 pl-4 pr-1.5">
      <span aria-hidden className="box-border block h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-[rgba(200,215,235,.6)]" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13.5px] font-semibold">{card.name} is asleep</span>
        <span className="truncate font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">{card.line}</span>
      </span>
      <button
        type="button"
        disabled={checking}
        onClick={onRetry}
        className="grid h-11 shrink-0 place-items-center rounded-[12px] border border-[rgba(150,205,255,.2)] px-3.5 text-[13px] font-semibold text-text-bright disabled:opacity-40"
      >
        Retry
      </button>
    </section>
  )
}

/**
 * No device of the group can reach this phone right now
 * (`GroupClient.unreachable`): its members may all be asleep, or it was
 * removed while away and nobody can tell it. Nothing is forgotten until the
 * user says so: "Pair again" forgets the group here, key kept, as "Forget
 * this group on this phone" does. Drawn as the asleep card is; provisional copy.
 */
function UnreachableCard() {
  const [busy, setBusy] = useState(false)
  const pairAgain = async () => {
    setBusy(true)
    try {
      await forgetGroupHere()
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mx-3 mb-2 flex items-center gap-3 rounded-[14px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.82)] py-1.5 pl-4 pr-1.5">
      <span aria-hidden className="box-border block h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-[rgba(200,215,235,.6)]" />
      <span className="min-w-0 flex-1 py-1 text-[13.5px] font-semibold leading-[1.35]">
        No device in your group can reach this phone right now.
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void pairAgain()}
        className="grid h-11 shrink-0 place-items-center rounded-[12px] border border-[rgba(150,205,255,.2)] px-3.5 text-[13px] font-semibold text-text-bright disabled:opacity-40"
      >
        Pair again
      </button>
    </section>
  )
}

/** Canvas 10a's pin mark after a title: a ring on a stem. */
function PinMark({ ink, dim = false }: { ink: string; dim?: boolean }) {
  return (
    <span role="img" aria-label="Pinned" className={['relative block h-[13px] w-2.5 shrink-0', dim ? 'opacity-70' : ''].join(' ')}>
      <span className="absolute left-[1.5px] top-0 box-border block h-[7px] w-[7px] rounded-full border-[1.5px]" style={{ borderColor: ink }} />
      <span className="absolute left-[4.3px] top-[7px] block h-1.5 w-[1.4px] rounded-[1px]" style={{ background: ink }} />
    </span>
  )
}

/** Canvas 10a: the title row's ink for the pin. */
const PIN_INK = 'rgba(200,220,245,.75)'
const PIN_INK_ENDED = 'rgba(200,220,245,.65)'

function SessionRow({
  session,
  tag,
  group,
  offline,
  asleep,
  device,
  mac,
  now,
  onOpen,
  onOpenSubagent,
  onOpenTask,
}: {
  session: ApiSession
  tag: Tag | undefined
  group: GroupKey
  /** Every device asleep: 9a's asleep list. */
  offline: boolean
  /**
   * In a group, this session's device asleep while others are not (canvas
   * 50j): the row as it was, dimmed and still, its time an `as of`.
   */
  asleep: boolean
  /** The device leading the second line, while two or more chips are on. */
  device: string | undefined
  /** The device the session runs on, as the limit line names it. */
  mac: string
  now: number
  onOpen: (id: string) => void
  onOpenSubagent: (ref: { sessionId: string; toolUseId: string }) => void
  onOpenTask: (ref: { sessionId: string; taskId: string }) => void
}) {
  const [moonsOpen, setMoonsOpen] = useState(false)
  const input = group === 'input'
  const reason = input ? inputReason(session) : null
  const dirMark = useClaudeDirMark(session.claudeDirId)
  const waitLine = group === 'limit' ? limitLine(session, offline || asleep, mac, now) : null
  const idle = group === 'idle'
  // A gate carries no elapsed time (10a); asleep, NEEDS INPUT shows none either (9a). The limit
  // row shows its last activity like every other row (spec § 8, Decision 9).
  // Its device asleep in a group: when it last sent, as 50j dates it (`as of 2h`).
  const asOf = asleep ? (session.machine?.asOf ?? null) : null
  const time =
    asOf !== null
      ? `as of ${timeAgo(asOf, now)}`
      : session.lastAt === null || (input && (offline || isGateRow(session)))
      ? null
      : idle
        ? agoLabel(session.lastAt, now)
        : timeAgo(session.lastAt, now)
  const summary = moonsSummary(session)
  const hasMoons = summary.subagents !== null || summary.tasks !== null
  // Canvas 10a asleep: a row with moons trades its where line for the counts, and the
  // NEEDS INPUT and limit rows keep only their reason.
  const asleepCounts = offline && hasMoons ? moonsSummaryAsleep(session) : null
  const showWhere = !(offline && (input || group === 'limit' || asleepCounts !== null))
  const moonColor = tag ? tagColor(tag.hue) : 'var(--state-neutral)'
  const runningMoons = session.subagents.filter((agent) => agent.state !== 'ended')
  // Expanded, the row lists what runs; the finished ones live behind the session's header chip.
  const tasks = tasksForRow(session.backgroundTasks).filter((task) => task.state === 'running')
  return (
    <div className={[input ? '' : 'mx-3 border-b border-[rgba(150,205,255,.06)]', asleep ? 'opacity-[.55]' : ''].join(' ')}>
      <button
        type="button"
        onClick={() => onOpen(session.id)}
        className={[
          'flex w-full items-center gap-2.5 text-left',
          // Canvas 10a, online and asleep.
          input
            ? [offline ? 'min-h-15' : 'min-h-16', 'py-2 pl-2 pr-3.5'].join(' ')
            : offline
              ? [group === 'limit' ? 'min-h-15' : asleepCounts !== null ? 'min-h-14' : 'min-h-15', asleepCounts !== null || group === 'limit' ? 'px-2 py-1.5' : 'p-2'].join(' ')
              : group === 'limit'
                ? 'min-h-16 p-2'
                : 'min-h-15 p-2',
        ].join(' ')}
      >
        <PlanetGlyph session={session} hue={tag?.hue} offline={offline || asleep} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-[7px]">
            <span
              className={[
                'truncate text-[15px] font-semibold',
                offline
                  ? 'text-[rgba(232,238,248,.85)]'
                  : idle
                    ? 'text-[rgba(232,238,248,.88)]'
                    : group === 'limit'
                      ? 'text-[rgba(232,238,248,.9)]'
                      : 'text-text-bright',
              ].join(' ')}
            >
              {session.title || 'Untitled session'}
            </span>
            {session.pinnedAt ? <PinMark ink={PIN_INK} dim={offline} /> : null}
            {isReadOnly(session) && (
              <span className="shrink-0 rounded-[4px] border border-[rgba(150,205,255,.2)] px-1.5 py-0.5 font-mono text-[9px] tracking-[0.12em] text-[rgba(160,190,225,.75)]">
                TERMINAL · READ-ONLY
              </span>
            )}
          </span>
          {/* 9a's cwd · branch line; 2h adds the worktree count. Canvas 44d:
              the Claude directory's mark opens it, before the tag dot, at the
              same x on every row. */}
          {showWhere &&
            (dirMark ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <ClaudeDirMark mono={dirMark.mono} size="phone" />
                <WhereLine session={session} dotColor={moonColor} variant="list" dim={offline} device={device} />
              </span>
            ) : (
              <WhereLine session={session} dotColor={moonColor} variant="list" dim={offline} device={device} />
            ))}
          {asleepCounts !== null && <span className="font-mono text-[11px] text-[rgba(160,190,225,.6)]">{asleepCounts}</span>}
          {reason && (
            <span className={['text-[12.5px] leading-[1.35]', offline ? 'text-[rgba(255,214,173,.75)]' : 'text-[#ffd6ad]'].join(' ')}>
              {reason}
            </span>
          )}
          {waitLine && (
            <span className={['text-[12.5px] leading-[1.35]', offline ? 'text-[rgba(200,215,235,.7)]' : 'text-[rgba(200,215,235,.8)]'].join(' ')}>
              {waitLine}
            </span>
          )}
        </span>
        {time !== null && (
          <span
            className={[
              'shrink-0 self-start whitespace-nowrap pt-[3px] font-mono text-[11px]',
              input ? 'text-[var(--state-input)]' : offline ? 'text-[rgba(160,190,225,.5)]' : idle ? 'text-[rgba(160,190,225,.55)]' : 'text-[rgba(160,190,225,.65)]',
            ].join(' ')}
          >
            {time}
          </span>
        )}
      </button>
      {hasMoons && !offline && !asleep && (
        <>
          {/* Canvas 10a: the collapsed summary, tasks after a ·. */}
          <button
            type="button"
            aria-expanded={moonsOpen}
            onClick={() => setMoonsOpen(!moonsOpen)}
            className="-mt-2.5 ml-[62px] flex h-11 min-w-0 max-w-[calc(100%-62px)] items-center gap-[9px] whitespace-nowrap pr-2.5 text-left"
          >
            {/* Only the running ones get a dot: a long-finished fleet would otherwise
                fill the row with dots that say nothing the count does not. */}
            {runningMoons.length > 0 && (
              <span className="flex shrink-0 gap-[5px]">
                {runningMoons.slice(0, MOONS_SHOWN).map((agent) => (
                  <Moon key={agent.id} color={moonColor} running />
                ))}
              </span>
            )}
            {summary.subagents !== null && (
              <span className="min-w-0 truncate font-mono text-[11px] text-[rgba(200,220,245,.75)]">{summary.subagents}</span>
            )}
            {summary.tasks !== null && (
              <span className="font-mono text-[11px] text-[rgba(200,220,245,.75)]">
                {summary.subagents !== null && <span className="text-[rgba(150,205,255,.3)]">· </span>}▣ {summary.tasks}
              </span>
            )}
            <span aria-hidden className="text-[9px] text-[rgba(160,190,225,.6)]">
              {moonsOpen ? '▾' : '▸'}
            </span>
          </button>
          {moonsOpen && (
            // Canvas 10a: 44 px rows ending in ›; a subagent opens 10f, ▣ a task 10g.
            <ul className="-mt-1 mb-2 ml-[62px] flex flex-col border-l border-[rgba(150,205,255,.12)]">
              {runningMoons.map((agent) => {
                const toolUseId = agent.toolUseId
                const body = (
                  <>
                    <Moon color={moonColor} running={agent.state !== 'ended'} small />
                    <span className="min-w-0 truncate text-text-bright">{agent.name}</span>
                    <span className="flex-1" />
                    <span className="shrink-0 text-[rgba(160,190,225,.65)]">{subagentStatus(agent, now)}</span>
                  </>
                )
                return (
                  <li key={agent.id}>
                    {toolUseId ? (
                      <button
                        type="button"
                        onClick={() => onOpenSubagent({ sessionId: session.id, toolUseId })}
                        className="flex h-11 w-full items-center gap-[9px] pl-3 text-left font-mono text-[11px]"
                      >
                        {body}
                        <Chevron />
                      </button>
                    ) : (
                      // A moon without its launching call cannot be opened (spec § 3): no ›.
                      <span className="flex h-11 items-center gap-[9px] pl-3 pr-6 font-mono text-[11px]">{body}</span>
                    )}
                  </li>
                )
              })}
              {tasks.map((task) => {
                const body = (
                  <>
                    <span aria-hidden className="block w-2 shrink-0 text-center text-[rgba(200,220,245,.75)]">
                      ▣
                    </span>
                    <span className="min-w-0 truncate text-text-bright">{task.label}</span>
                    <span className="flex-1" />
                    <span className="shrink-0 text-[rgba(160,190,225,.65)]">{taskStatus(task, now)}</span>
                  </>
                )
                return (
                  <li key={task.id}>
                    {opensTask(task) ? (
                      <button
                        type="button"
                        onClick={() => onOpenTask({ sessionId: session.id, taskId: task.id })}
                        className="flex h-11 w-full items-center gap-[9px] pl-3 text-left font-mono text-[11px]"
                      >
                        {body}
                        <Chevron />
                      </button>
                    ) : (
                      // A task without an output file has nothing to open, as in the 10f sheet: no ›.
                      <span className="flex h-11 items-center gap-[9px] pl-3 pr-6 font-mono text-[11px]">{body}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/** The › that ends an openable moons row (canvas 10a). */
function Chevron() {
  return (
    <span aria-hidden className="block w-6 shrink-0 text-center text-[14px] text-[rgba(160,190,225,.6)]">
      ›
    </span>
  )
}

/** The collapsed moons row draws at most this many running dots before the count. */
const MOONS_SHOWN = 5

/** A subagent's dot (9p "SUBAGENTS ROW"): the session's tag hue, pulsing while it runs; a finished one goes grey. */
function Moon({ color, running, small = false }: { color: string; running: boolean; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={[
        'box-border block shrink-0 rounded-full border bg-[oklch(30%_.05_220)]',
        small ? 'h-2 w-2' : 'h-[9px] w-[9px]',
        running ? 'orbital-pulse' : '',
      ].join(' ')}
      style={{ borderColor: running ? color : 'rgba(200,215,235,.35)' }}
    />
  )
}

/**
 * An ended row (9a, expanded): smaller, faded, a grey planet and no branch.
 * `pinned` is 10a's headless row above the fold: the pin after the title and
 * "· ended, pinned" after the folder.
 */
function EndedRow({
  session,
  tag,
  device,
  now,
  onOpen,
  pinned = false,
}: {
  session: ApiSession
  tag: Tag | undefined
  /** The device it ran on, leading the folder while two or more devices show (as the live rows). */
  device?: string
  now: number
  onOpen: (id: string) => void
  pinned?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(session.id)}
      className={[
        'mx-3 flex min-h-13 w-[calc(100%-24px)] items-center gap-2.5 text-left',
        pinned ? 'px-2 py-1 opacity-80' : 'border-b border-[rgba(150,205,255,.05)] px-2 py-1 opacity-75',
      ].join(' ')}
    >
      <PlanetGlyph session={session} offline={false} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-[7px]">
          <span className={['truncate text-[14px] font-semibold', pinned ? 'text-[rgba(220,235,255,.75)]' : 'text-[rgba(220,235,255,.7)]'].join(' ')}>
            {session.title || 'Untitled session'}
          </span>
          {pinned && <PinMark ink={PIN_INK_ENDED} />}
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">
          <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full opacity-70" style={{ background: tag ? tagColor(tag.hue) : 'var(--state-neutral)' }} />
          <span className="truncate">
            {device && `${device} · `}
            {basename(session.cwd)}
            {pinned && ' · ended, pinned'}
          </span>
        </span>
      </span>
      {session.lastAt !== null && <span className="shrink-0 font-mono text-[11px] text-[rgba(160,190,225,.45)]">{timeAgo(session.lastAt, now)}</span>}
    </button>
  )
}
