import { swatch } from '../../lib/palette'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { timeAgo } from '../../lib/format'
import { toggleTag } from '../../lib/tagFilter'
import { sessionViewTransitionName, withViewTransition } from '../../lib/viewTransition'
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
  GROUP_LABEL, endedHeading, groupSessions, inputReason, isGateRow, limitLine, moonsSummary, moonsSummaryAsleep, subagentStatus, tagChips,
  taskStatus, tasksForRow, type GroupKey,
} from '../sessionList'
import { primaryTag } from '../../lib/primaryTag'
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
        <span className="fs-13 font-bold tracking-[0.22em]">ORBITAL</span>
        {/* Canvas 50j: in a group the header names no one Mac; the chips say who is up. */}
        <span className="flex h-11 min-w-0 flex-1 items-center justify-end gap-[7px] px-2.5 font-mono fs-11.5 text-ink-200/85">
          {!several && (
            <>
              <MacDot state={offline ? 'asleep' : link === 'online' ? 'online' : 'connecting'} />
              <span className={['truncate', offline ? 'text-ink-600/65' : ''].join(' ')}>{mac}</span>
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
            className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] text-ink-400/85"
          >
            <LimitsGlyph size="phone" />
          </button>
        )}
        <button type="button" aria-label="Settings" onClick={() => go('settings')} className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px]">
          <span aria-hidden className="block h-4 w-4 rounded-full border-[1.5px] border-dashed border-accent" />
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
              onClick={() => withViewTransition(() => setTagIds(toggleTag(tagIds, tag.id)))}
              label={tag.name}
              count={live}
              hue={tag.hue}
            />
          ))}
          {/* Canvas `Feature - Tag chips` 80b: no All; Clear ends the row while a tag is on, pinned to the
              right edge over a fade so it never scrolls out of sight. The pin stays as the row's end padding. */}
          <div className="sticky right-0 flex flex-none bg-[linear-gradient(90deg,color-mix(in_oklab,_var(--color-space)_0%,_transparent),#05070d_14px)] pl-[18px] pr-4">
            {tagIds.length > 0 && <Chip active={false} muted onClick={() => withViewTransition(() => setTagIds([]))} label="Clear" />}
          </div>
        </div>
      )}

      {offline && !several && (
        <section className="mx-3 mb-2.5 mt-0.5 flex items-start gap-3 rounded-[16px] border border-line/16 bg-panel/82 py-3 pl-4 pr-3">
          <span aria-hidden className="mt-1 block h-3 w-3 shrink-0 rounded-full border-[1.5px] border-ink-600/60" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="fs-14.5 font-semibold">{mac} is asleep</span>
            <span className="fs-12.5 leading-[1.45] text-ink-900/75">
              Showing what it last sent. Reconnects on its own when the Mac wakes.
            </span>
            <span className="font-mono fs-10.5 text-ink-900/60">
              {[asOf !== null ? asOfLabel(asOf, now) : null, checkedAt !== null ? checkedLabel(checkedAt, now) : null]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          <button
            type="button"
            disabled={checking}
            onClick={() => void retry()}
            className="h-11 shrink-0 rounded-[12px] border border-line/20 px-3.5 fs-13 font-semibold text-ink-100 disabled:opacity-40"
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
    <div className="border-t border-line/8 bg-[linear-gradient(180deg,transparent,color-mix(in_oklab,_var(--color-space)_95%,_transparent)_30%)] px-4 pb-1.5 pt-2.5">
      {offline ? (
        <div
          aria-disabled="true"
          className="flex h-13 items-center justify-center rounded-[14px] border border-line/14 px-4 text-center fs-14 font-semibold text-ink-900/60"
        >
          {several ? 'New session · needs a device awake' : `New session · needs ${mac} awake`}
        </div>
      ) : (
        <PrimaryButton onClick={() => go('new')}>
          <span aria-hidden className="fs-20 font-medium leading-none">
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
                  className="mx-3 mt-2.5 flex h-12 w-[calc(100%-24px)] items-center gap-2.5 rounded-[12px] px-2 text-left font-mono fs-10.5 tracking-[0.16em] text-ink-900/60"
                >
                  <span aria-hidden className="fs-9">
                    {endedOpen ? '▾' : '▸'}
                  </span>
                  <span aria-hidden className="block h-2 w-2 rounded-full border border-ink-600/45" />
                  <span>
                    {GROUP_LABEL.ended}
                    {heading?.count != null && <> · {heading.count}</>}
                  </span>
                  {latest !== null && (
                    <span className="ml-auto tracking-[0.04em] text-ink-900/60">latest {agoLabel(latest, now)}</span>
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
              {listOffline && <span className="tracking-[0.06em] text-ink-900/60"> · last known</span>}
            </>
          )
          if (group.key === 'input') {
            return (
              <section
                key="input"
                className={[
                  'mx-3 mb-1.5 overflow-hidden rounded-[18px] border',
                  listOffline
                    ? 'border-warning/28 bg-warning/4'
                    : 'border-warning/42 bg-[linear-gradient(180deg,color-mix(in_oklab,_var(--color-warning)_9%,_transparent),color-mix(in_oklab,_var(--color-warning)_2%,_transparent))] shadow-[0_0_30px_color-mix(in_oklab,_var(--color-warning)_6%,_transparent)]',
                ].join(' ')}
              >
                <div className="flex items-center gap-2 px-4 pb-0.5 pt-3 font-mono fs-10.5 tracking-[0.16em] text-[var(--state-input)]">
                  <span aria-hidden className={['block h-1.5 w-1.5 rounded-full bg-[var(--state-input)]', listOffline ? '' : 'orbital-breathe'].join(' ')} />
                  {label}
                </div>
                {rows}
                {listOffline && (
                  <p className="pb-3 pl-[70px] pr-4 fs-12 leading-[1.4] text-ink-900/60">
                    Readable, gates and cards included; answering waits for the Mac.
                  </p>
                )}
              </section>
            )
          }
          return (
            <section key={group.key}>
              <div className="px-5 pb-0.5 pt-3.5 font-mono fs-10.5 tracking-[0.16em] text-ink-900/60">{label}</div>
              {rows}
            </section>
          )
        })}

        {groups.length === 0 && (
          <p className="px-8 py-10 text-center fs-13 text-ink-900/60">
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
      className="relative block h-4 w-4 shrink-0 rounded-full border-[1.5px] border-accent shadow-[0_0_10px_color-mix(in_oklab,var(--color-accent)_50%,transparent)]"
    >
      <span className="absolute -right-px -top-px block h-[5px] w-[5px] rounded-full bg-accent" />
    </span>
  )
}

/** The Mac's presence beside its name: lit online, hollow asleep, dim while the relay link comes up. */
function MacDot({ state }: { state: 'online' | 'asleep' | 'connecting' }) {
  if (state === 'asleep') {
    return <span role="img" aria-label="asleep" className="block h-[7px] w-[7px] shrink-0 rounded-full border-[1.2px] border-ink-600/60" />
  }
  return (
    <span
      role="img"
      aria-label={state === 'online' ? 'online' : 'connecting to the relay'}
      className={[
        'block h-[7px] w-[7px] shrink-0 rounded-full bg-accent',
        state === 'online' ? 'shadow-[0_0_8px_var(--color-accent)]' : 'opacity-40',
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
        'flex h-9 shrink-0 items-center gap-[7px] rounded-full border px-[13px] fs-13 font-semibold',
        active
          ? 'border-line/30 bg-line/14 text-ink-100'
          : muted
            ? 'border-line/14 text-ink-900/60'
            : 'border-line/14 text-ink-500/75',
      ].join(' ')}
    >
      {hue !== undefined && <span aria-hidden className="block h-1.5 w-1.5 rounded-full" style={{ background: tagColor(hue) }} />}
      <span>{label}</span>
      {count !== undefined && <span className="font-mono fs-10.5 font-normal text-ink-900/60">{count}</span>}
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
        'flex h-9 shrink-0 items-center gap-[7px] rounded-full border px-3 fs-13 font-semibold',
        on ? 'border-line/30 bg-line/14 text-ink-100' : 'border-line/14 text-ink-900/60',
        chip.offline ? 'opacity-50' : '',
      ].join(' ')}
    >
      <KindGlyph kind={chip.kind} untitled />
      <span>{chip.label}</span>
      {chip.update && <span className="font-mono fs-10 font-normal text-ink-900/75">update</span>}
      <span className="font-mono fs-10.5 font-normal text-ink-900/60">{chip.count}</span>
    </button>
  )
}

/** One asleep device in a group (canvas 50j ASLEEP, PER DEVICE): its rows stay below, dimmed. */
function AsleepDeviceCard({ card, checking, onRetry }: { card: AsleepCard; checking: boolean; onRetry: () => void }) {
  return (
    <section className="mx-3 mb-2 flex items-center gap-3 rounded-[14px] border border-line/16 bg-panel/82 py-1.5 pl-4 pr-1.5">
      <span aria-hidden className="box-border block h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-ink-600/60" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate fs-13.5 font-semibold">{card.name} is asleep</span>
        <span className="truncate font-mono fs-10.5 text-ink-900/60">{card.line}</span>
      </span>
      <button
        type="button"
        disabled={checking}
        onClick={onRetry}
        className="grid h-11 shrink-0 place-items-center rounded-[12px] border border-line/20 px-3.5 fs-13 font-semibold text-ink-100 disabled:opacity-40"
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
    <section className="mx-3 mb-2 flex items-center gap-3 rounded-[14px] border border-line/16 bg-panel/82 py-1.5 pl-4 pr-1.5">
      <span aria-hidden className="box-border block h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-ink-600/60" />
      <span className="min-w-0 flex-1 py-1 fs-13.5 font-semibold leading-[1.35]">
        No device in your group can reach this phone right now.
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void pairAgain()}
        className="grid h-11 shrink-0 place-items-center rounded-[12px] border border-line/20 px-3.5 fs-13 font-semibold text-ink-100 disabled:opacity-40"
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
const PIN_INK = swatch('ink-500', 0.75)
const PIN_INK_ENDED = swatch('ink-500', 0.65)

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
    <div
      // Its own snapshot when the tag filter changes: the row glides to its new place (80b).
      style={{ viewTransitionName: sessionViewTransitionName(session.id) }}
      className={[input ? '' : 'mx-3 border-b border-line/6', asleep ? 'opacity-[.55]' : ''].join(' ')}
    >
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
                'truncate fs-15 font-semibold',
                offline
                  ? 'text-ink-100/85'
                  : idle
                    ? 'text-ink-100/88'
                    : group === 'limit'
                      ? 'text-ink-100/90'
                      : 'text-ink-100',
              ].join(' ')}
            >
              {session.title || 'Untitled session'}
            </span>
            {session.pinnedAt ? <PinMark ink={PIN_INK} dim={offline} /> : null}
            {isReadOnly(session) && (
              <span className="shrink-0 rounded-[4px] border border-line/20 px-1.5 py-0.5 font-mono fs-9 tracking-[0.12em] text-ink-900/75">
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
          {asleepCounts !== null && <span className="font-mono fs-11 text-ink-900/60">{asleepCounts}</span>}
          {reason && (
            <span className={['fs-12.5 leading-[1.35]', offline ? 'text-warning-soft/75' : 'text-warning-soft'].join(' ')}>
              {reason}
            </span>
          )}
          {waitLine && (
            <span className={['fs-12.5 leading-[1.35]', offline ? 'text-ink-600/70' : 'text-ink-600/80'].join(' ')}>
              {waitLine}
            </span>
          )}
        </span>
        {time !== null && (
          <span
            className={[
              'shrink-0 self-start whitespace-nowrap pt-[3px] font-mono fs-11',
              input ? 'text-[var(--state-input)]' : offline ? 'text-ink-900/50' : idle ? 'text-ink-900/55' : 'text-ink-900/65',
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
              <span className="min-w-0 truncate font-mono fs-11 text-ink-500/75">{summary.subagents}</span>
            )}
            {summary.tasks !== null && (
              <span className="font-mono fs-11 text-ink-500/75">
                {summary.subagents !== null && <span className="text-line/30">· </span>}▣ {summary.tasks}
              </span>
            )}
            <span aria-hidden className="fs-9 text-ink-900/60">
              {moonsOpen ? '▾' : '▸'}
            </span>
          </button>
          {moonsOpen && (
            // Canvas 10a: 44 px rows ending in ›; a subagent opens 10f, ▣ a task 10g.
            <ul className="-mt-1 mb-2 ml-[62px] flex flex-col border-l border-line/12">
              {runningMoons.map((agent) => {
                const toolUseId = agent.toolUseId
                const body = (
                  <>
                    <Moon color={moonColor} running={agent.state !== 'ended'} small />
                    <span className="min-w-0 truncate text-ink-100">{agent.name}</span>
                    <span className="flex-1" />
                    <span className="shrink-0 text-ink-900/65">{subagentStatus(agent, now)}</span>
                  </>
                )
                return (
                  <li key={agent.id}>
                    {toolUseId ? (
                      <button
                        type="button"
                        onClick={() => onOpenSubagent({ sessionId: session.id, toolUseId })}
                        className="flex h-11 w-full items-center gap-[9px] pl-3 text-left font-mono fs-11"
                      >
                        {body}
                        <Chevron />
                      </button>
                    ) : (
                      // A moon without its launching call cannot be opened (spec § 3): no ›.
                      <span className="flex h-11 items-center gap-[9px] pl-3 pr-6 font-mono fs-11">{body}</span>
                    )}
                  </li>
                )
              })}
              {tasks.map((task) => {
                const body = (
                  <>
                    <span aria-hidden className="block w-2 shrink-0 text-center text-ink-500/75">
                      ▣
                    </span>
                    <span className="min-w-0 truncate text-ink-100">{task.label}</span>
                    <span className="flex-1" />
                    <span className="shrink-0 text-ink-900/65">{taskStatus(task, now)}</span>
                  </>
                )
                return (
                  <li key={task.id}>
                    {opensTask(task) ? (
                      <button
                        type="button"
                        onClick={() => onOpenTask({ sessionId: session.id, taskId: task.id })}
                        className="flex h-11 w-full items-center gap-[9px] pl-3 text-left font-mono fs-11"
                      >
                        {body}
                        <Chevron />
                      </button>
                    ) : (
                      // A task without an output file has nothing to open, as in the 10f sheet: no ›.
                      <span className="flex h-11 items-center gap-[9px] pl-3 pr-6 font-mono fs-11">{body}</span>
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
    <span aria-hidden className="block w-6 shrink-0 text-center fs-14 text-ink-900/60">
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
        'box-border block shrink-0 rounded-full border bg-[var(--color-body-hi)]',
        small ? 'h-2 w-2' : 'h-[9px] w-[9px]',
        running ? 'orbital-pulse' : '',
      ].join(' ')}
      style={{ borderColor: running ? color : swatch('ink-600', 0.35) }}
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
      style={{ viewTransitionName: sessionViewTransitionName(session.id) }}
      className={[
        'mx-3 flex min-h-13 w-[calc(100%-24px)] items-center gap-2.5 text-left',
        pinned ? 'px-2 py-1 opacity-80' : 'border-b border-line/5 px-2 py-1 opacity-75',
      ].join(' ')}
    >
      <PlanetGlyph session={session} offline={false} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-[7px]">
          <span className={['truncate fs-14 font-semibold', pinned ? 'text-ink-200/75' : 'text-ink-200/70'].join(' ')}>
            {session.title || 'Untitled session'}
          </span>
          {pinned && <PinMark ink={PIN_INK_ENDED} />}
        </span>
        <span className="flex items-center gap-1.5 font-mono fs-10.5 text-ink-900/55">
          <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full opacity-70" style={{ background: tag ? tagColor(tag.hue) : 'var(--state-neutral)' }} />
          <span className="truncate">
            {device && `${device} · `}
            {basename(session.cwd)}
            {pinned && ' · ended, pinned'}
          </span>
        </span>
      </span>
      {session.lastAt !== null && <span className="shrink-0 font-mono fs-11 text-ink-900/60">{timeAgo(session.lastAt, now)}</span>}
    </button>
  )
}
