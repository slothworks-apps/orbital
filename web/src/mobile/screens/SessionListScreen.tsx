import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { timeAgo } from '../../lib/format'
import { isReadOnly, tagColor, type ApiSession, type Tag } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { useOrbital } from '../../store/store'
import { recheckMac } from '../connect'
import { CLOCK_TICK_MS, RETRY_WINDOW_MS } from '../constants'
import { agoLabel, asOfLabel, basename, checkedLabel } from '../format'
import {
  GROUP_LABEL, groupSessions, inputReason, isGateRow, latestActivity, limitLine, moonsSummary, moonsSummaryAsleep, subagentStatus, tagChips,
  taskStatus, tasksForRow, type GroupKey,
} from '../sessionList'
import { isMacAsleep, useMobile } from '../state'
import { MobileScreen, PrimaryButton } from '../ui'
import { PlanetGlyph } from './Glyph'

/** 9a, updated by 10a (spec 2026-10-05-mobile-next-design): the sessions, grouped by what they need from you. */
export function SessionListScreen() {
  const sessions = useOrbital(
    useShallow((s) => s.order.map((id) => s.sessions[id]).filter((x): x is ApiSession => x !== undefined)),
  )
  const tags = useOrbital((s) => s.tags)
  const { offline, link, macName, asOf, checkedAt } = useMobile(
    useShallow((s) => ({ offline: isMacAsleep(s), link: s.link, macName: s.macName, asOf: s.asOf, checkedAt: s.checkedAt })),
  )
  const openSession = useMobile((s) => s.openSession)
  const openSubagent = useMobile((s) => s.openSubagent)
  const openTask = useMobile((s) => s.openTask)
  const go = useMobile((s) => s.go)
  const [tagId, setTagId] = useState<number | null>(null)
  const [endedOpen, setEndedOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const now = useNow(true, CLOCK_TICK_MS)

  const mac = macName ?? 'Your Mac'
  const groups = useMemo(() => groupSessions(sessions, tagId), [sessions, tagId])
  const chips = useMemo(() => tagChips(sessions, tags), [sessions, tags])
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])
  const liveCount = useMemo(() => sessions.filter((s) => s.status !== 'ended').length, [sessions])

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
        <span className="flex h-11 min-w-0 flex-1 items-center justify-end gap-[7px] px-2.5 font-mono text-[11.5px] text-[rgba(220,235,255,.85)]">
          <MacDot state={offline ? 'asleep' : link === 'online' ? 'online' : 'connecting'} />
          <span className={['truncate', offline ? 'text-[rgba(200,215,235,.65)]' : ''].join(' ')}>{mac}</span>
        </span>
        <button type="button" aria-label="Settings" onClick={() => go('settings')} className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px]">
          <span aria-hidden className="block h-4 w-4 rounded-full border-[1.5px] border-dashed border-[oklch(85%_.12_205)]" />
        </button>
      </div>

      {chips.length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-4 pb-2.5 pt-1">
          <Chip active={tagId === null} onClick={() => setTagId(null)} label="All" count={liveCount} />
          {chips.map(({ tag, live }) => (
            <Chip
              key={tag.id}
              active={tagId === tag.id}
              onClick={() => setTagId(tagId === tag.id ? null : tag.id)}
              label={tag.name}
              count={live}
              hue={tag.hue}
            />
          ))}
        </div>
      )}

      {offline && (
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
          New session · needs {mac} awake
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
        {groups.map((group) => {
          if (group.key === 'ended') {
            const latest = latestActivity(group.sessions)
            return (
              <section key="ended">
                <button
                  type="button"
                  aria-expanded={endedOpen}
                  onClick={() => setEndedOpen(!endedOpen)}
                  className="mx-3 mt-2.5 flex h-12 w-[calc(100%-24px)] items-center gap-2.5 rounded-[12px] px-2 text-left font-mono text-[10.5px] tracking-[0.16em] text-[rgba(160,190,225,.6)]"
                >
                  <span aria-hidden className="text-[9px]">
                    {endedOpen ? '▾' : '▸'}
                  </span>
                  <span aria-hidden className="block h-2 w-2 rounded-full border border-[rgba(200,215,235,.45)]" />
                  <span>
                    {GROUP_LABEL.ended} · {group.sessions.length}
                  </span>
                  {latest !== null && (
                    <span className="ml-auto tracking-[0.04em] text-[rgba(160,190,225,.45)]">latest {agoLabel(latest, now)}</span>
                  )}
                </button>
                {endedOpen && group.sessions.map((s) => <EndedRow key={s.id} session={s} tag={tagById.get(s.tagIds[0])} now={now} onOpen={openSession} />)}
              </section>
            )
          }
          if (group.key === 'pinned') {
            // Canvas 10a: headless, above the ENDED fold until unpinned.
            return (
              <section key="pinned" className="mt-1.5">
                {group.sessions.map((s) => (
                  <EndedRow key={s.id} session={s} tag={tagById.get(s.tagIds[0])} now={now} onOpen={openSession} pinned />
                ))}
              </section>
            )
          }
          const rows = group.sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              tag={tagById.get(s.tagIds[0])}
              group={group.key}
              offline={offline}
              mac={mac}
              now={now}
              onOpen={openSession}
              onOpenSubagent={openSubagent}
              onOpenTask={openTask}
            />
          ))
          const label = (
            <>
              {GROUP_LABEL[group.key]} · {group.sessions.length}
              {offline && <span className="tracking-[0.06em] text-[rgba(160,190,225,.45)]"> · last known</span>}
            </>
          )
          if (group.key === 'input') {
            return (
              <section
                key="input"
                className={[
                  'mx-3 mb-1.5 overflow-hidden rounded-[18px] border',
                  offline
                    ? 'border-[rgba(255,187,123,.28)] bg-[rgba(255,187,123,.04)]'
                    : 'border-[rgba(255,187,123,.42)] bg-[linear-gradient(180deg,rgba(255,187,123,.09),rgba(255,187,123,.02))] shadow-[0_0_30px_rgba(255,187,123,.06)]',
                ].join(' ')}
              >
                <div className="flex items-center gap-2 px-4 pb-0.5 pt-3 font-mono text-[10.5px] tracking-[0.16em] text-[var(--state-input)]">
                  <span aria-hidden className={['block h-1.5 w-1.5 rounded-full bg-[var(--state-input)]', offline ? '' : 'orbital-breathe'].join(' ')} />
                  {label}
                </div>
                {rows}
                {offline && (
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
            {tagId === null ? 'No sessions yet.' : `No live sessions tagged ${tagById.get(tagId)?.name ?? ''}.`}
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
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
  hue?: number
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
          : 'border-[rgba(150,205,255,.14)] text-[rgba(200,220,245,.75)]',
      ].join(' ')}
    >
      {hue !== undefined && <span aria-hidden className="block h-1.5 w-1.5 rounded-full" style={{ background: tagColor(hue) }} />}
      <span>{label}</span>
      {count !== undefined && <span className="font-mono text-[10.5px] font-normal text-[rgba(160,190,225,.6)]">{count}</span>}
    </button>
  )
}

/** The cwd · branch line under a title (9a), mono, with the tag's dot. */
function WhereLine({ session, tag, dim = false }: { session: ApiSession; tag: Tag | undefined; dim?: boolean }) {
  return (
    <span
      className={[
        'flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-[11px]',
        dim ? 'text-[rgba(160,190,225,.65)]' : 'text-[rgba(160,190,225,.7)]',
      ].join(' ')}
    >
      <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tag ? tagColor(tag.hue) : 'var(--state-neutral)' }} />
      <span className="shrink-0">{basename(session.cwd)}</span>
      {session.git && (
        <>
          <span aria-hidden className="text-[rgba(150,205,255,.3)]">
            ·
          </span>
          <span className="truncate">⎇ {session.git.ref}</span>
        </>
      )}
    </span>
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
  mac,
  now,
  onOpen,
  onOpenSubagent,
  onOpenTask,
}: {
  session: ApiSession
  tag: Tag | undefined
  group: GroupKey
  offline: boolean
  mac: string
  now: number
  onOpen: (id: string) => void
  onOpenSubagent: (ref: { sessionId: string; toolUseId: string }) => void
  onOpenTask: (ref: { sessionId: string; taskId: string }) => void
}) {
  const [moonsOpen, setMoonsOpen] = useState(false)
  const input = group === 'input'
  const reason = input ? inputReason(session) : null
  const waitLine = group === 'limit' ? limitLine(session, offline, mac, now) : null
  const idle = group === 'idle'
  // A gate carries no elapsed time (10a); asleep, NEEDS INPUT shows none either (9a). The limit
  // row shows its last activity like every other row (spec § 8, Decision 9).
  const time =
    session.lastAt === null || (input && (offline || isGateRow(session)))
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
  const tasks = tasksForRow(session.backgroundTasks)
  return (
    <div className={input ? '' : 'mx-3 border-b border-[rgba(150,205,255,.06)]'}>
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
        <PlanetGlyph session={session} offline={offline} />
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
          {showWhere && <WhereLine session={session} tag={tag} dim={offline} />}
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
      {hasMoons && !offline && (
        <>
          {/* Canvas 10a: the collapsed summary, tasks after a ·. */}
          <button
            type="button"
            aria-expanded={moonsOpen}
            onClick={() => setMoonsOpen(!moonsOpen)}
            className="-mt-2.5 ml-[62px] flex h-11 items-center gap-[9px] pr-2.5 text-left"
          >
            {session.subagents.length > 0 && (
              <span className="flex gap-[5px]">
                {session.subagents.map((agent) => (
                  <Moon key={agent.id} color={moonColor} running={agent.state !== 'ended'} />
                ))}
              </span>
            )}
            {summary.subagents !== null && <span className="font-mono text-[11px] text-[rgba(200,220,245,.75)]">{summary.subagents}</span>}
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
              {session.subagents.map((agent) => {
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
              {tasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => onOpenTask({ sessionId: session.id, taskId: task.id })}
                    className="flex h-11 w-full items-center gap-[9px] pl-3 text-left font-mono text-[11px]"
                  >
                    <span aria-hidden className="block w-2 shrink-0 text-center text-[rgba(200,220,245,.75)]">
                      ▣
                    </span>
                    <span className="min-w-0 truncate text-text-bright">{task.label}</span>
                    <span className="flex-1" />
                    <span className="shrink-0 text-[rgba(160,190,225,.65)]">{taskStatus(task, now)}</span>
                    <Chevron />
                  </button>
                </li>
              ))}
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

/** A subagent's dot (9p "SUBAGENTS ROW"): the session's tag hue; running ones pulse. */
function Moon({ color, running, small = false }: { color: string; running: boolean; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={[
        'box-border block shrink-0 rounded-full border bg-[oklch(30%_.05_220)]',
        small ? 'h-2 w-2' : 'h-[9px] w-[9px]',
        running ? 'orbital-pulse' : '',
      ].join(' ')}
      style={{ borderColor: color }}
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
  now,
  onOpen,
  pinned = false,
}: {
  session: ApiSession
  tag: Tag | undefined
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
            {basename(session.cwd)}
            {pinned && ' · ended, pinned'}
          </span>
        </span>
      </span>
      {session.lastAt !== null && <span className="shrink-0 font-mono text-[11px] text-[rgba(160,190,225,.45)]">{timeAgo(session.lastAt, now)}</span>}
    </button>
  )
}
