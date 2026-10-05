import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { timeAgo } from '../../lib/format'
import { isReadOnly, tagColor, type ApiSession, type Tag } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { useOrbital } from '../../store/store'
import { recheckMac } from '../connect'
import { CLOCK_TICK_MS, RETRY_WINDOW_MS } from '../constants'
import { agoLabel, asOfLabel, basename, checkedLabel } from '../format'
import { GROUP_LABEL, decisionReason, groupSessions, latestActivity, tagChips, type GroupKey } from '../sessionList'
import { isMacAsleep, useMobile } from '../state'
import { MobileScreen, PrimaryButton } from '../ui'
import { PlanetGlyph } from './Glyph'

/** 9a (spec § 5): the sessions, grouped by what they need from you. */
export function SessionListScreen() {
  const sessions = useOrbital(
    useShallow((s) => s.order.map((id) => s.sessions[id]).filter((x): x is ApiSession => x !== undefined)),
  )
  const tags = useOrbital((s) => s.tags)
  const { offline, link, macName, asOf, checkedAt } = useMobile(
    useShallow((s) => ({ offline: isMacAsleep(s), link: s.link, macName: s.macName, asOf: s.asOf, checkedAt: s.checkedAt })),
  )
  const openSession = useMobile((s) => s.openSession)
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
          const rows = group.sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              tag={tagById.get(s.tagIds[0])}
              group={group.key}
              offline={offline}
              now={now}
              onOpen={openSession}
              tagHue={tagById.get(s.tagIds[0])?.hue}
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
                    You can read these; answering waits for the Mac.
                  </p>
                )}
              </section>
            )
          }
          return (
            <section key={group.key}>
              <div className="px-5 pb-0.5 pt-4 font-mono text-[10.5px] tracking-[0.16em] text-[rgba(160,190,225,.6)]">{label}</div>
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

function SessionRow({
  session,
  tag,
  group,
  offline,
  now,
  onOpen,
  tagHue,
}: {
  session: ApiSession
  tag: Tag | undefined
  group: GroupKey
  offline: boolean
  now: number
  onOpen: (id: string) => void
  tagHue: number | undefined
}) {
  const [moonsOpen, setMoonsOpen] = useState(false)
  const reason = group === 'input' ? decisionReason(session.pendingDecision) : null
  const idle = group === 'idle'
  const time =
    session.lastAt === null || (offline && group === 'input') ? null : idle ? agoLabel(session.lastAt, now) : timeAgo(session.lastAt, now)
  const running = session.subagents.filter((a) => a.state !== 'ended').length
  const moonColor = tagHue !== undefined ? tagColor(tagHue) : 'var(--state-neutral)'
  return (
    <div className={group === 'input' ? '' : 'mx-3 border-b border-[rgba(150,205,255,.06)]'}>
      <button
        type="button"
        onClick={() => onOpen(session.id)}
        className={[
          'flex w-full items-center gap-2.5 text-left',
          group === 'input' ? 'min-h-16 py-2.5 pl-2 pr-3.5' : offline ? 'min-h-15 p-2' : 'min-h-16 px-2 py-2.5',
        ].join(' ')}
      >
        <PlanetGlyph session={session} offline={offline} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={[
                'truncate text-[15px] font-semibold',
                offline ? 'text-[rgba(232,238,248,.85)]' : idle ? 'text-[rgba(232,238,248,.88)]' : 'text-text-bright',
              ].join(' ')}
            >
              {session.title || 'Untitled session'}
            </span>
            {isReadOnly(session) && (
              <span className="shrink-0 rounded-[4px] border border-[rgba(150,205,255,.2)] px-1.5 py-0.5 font-mono text-[9px] tracking-[0.12em] text-[rgba(160,190,225,.75)]">
                TERMINAL · READ-ONLY
              </span>
            )}
          </span>
          <WhereLine session={session} tag={tag} dim={offline} />
          {reason && (
            <span className={['text-[12.5px] leading-[1.35]', offline ? 'text-[rgba(255,214,173,.75)]' : 'text-[#ffd6ad]'].join(' ')}>
              {reason}
            </span>
          )}
        </span>
        {time !== null && (
          <span
            className={[
              'shrink-0 self-start whitespace-nowrap pt-[3px] font-mono text-[11px]',
              group === 'input' ? 'text-[var(--state-input)]' : offline ? 'text-[rgba(160,190,225,.5)]' : idle ? 'text-[rgba(160,190,225,.55)]' : 'text-[rgba(160,190,225,.65)]',
            ].join(' ')}
          >
            {time}
          </span>
        )}
      </button>
      {session.subagents.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={moonsOpen}
            onClick={() => setMoonsOpen(!moonsOpen)}
            className="-mt-2.5 ml-[62px] flex h-11 items-center gap-[9px] pr-2.5 text-left"
          >
            <span className="flex gap-[5px]">
              {session.subagents.map((agent) => (
                <Moon key={agent.id} color={moonColor} running={!offline && agent.state !== 'ended'} />
              ))}
            </span>
            <span className="font-mono text-[11px] text-[rgba(200,220,245,.75)]">
              {session.subagents.length} {session.subagents.length === 1 ? 'subagent' : 'subagents'} · {running} running
            </span>
            <span aria-hidden className="text-[9px] text-[rgba(160,190,225,.6)]">
              {moonsOpen ? '▾' : '▸'}
            </span>
          </button>
          {moonsOpen && (
            <ul className="-mt-1 mb-2.5 ml-[62px] border-l border-[rgba(150,205,255,.12)]">
              {session.subagents.map((agent) => (
                <li key={agent.id} className="flex h-[34px] items-center gap-[9px] pl-3 font-mono text-[11px]">
                  <Moon color={moonColor} running={!offline && agent.state !== 'ended'} small />
                  <span className="min-w-0 truncate text-text-bright">{agent.name}</span>
                  <span className="ml-auto shrink-0 pr-2 text-[rgba(160,190,225,.65)]">
                    {agent.state === 'ended' ? 'done' : 'running'}
                    {' · '}
                    {timeAgo(agent.state === 'ended' ? (agent.endedAt ?? agent.startedAt) : agent.startedAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/** A subagent's dot (9p "SUBAGENTS ROW"): the session's tag hue; running ones pulse. */
function Moon({ color, running, small = false }: { color: string; running: boolean; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={[
        'block shrink-0 rounded-full border bg-[oklch(30%_.05_220)]',
        small ? 'h-2 w-2' : 'h-[9px] w-[9px]',
        running ? 'orbital-pulse' : '',
      ].join(' ')}
      style={{ borderColor: color }}
    />
  )
}

/** An ended row (9a, expanded): smaller, faded, a grey planet and no branch. */
function EndedRow({
  session,
  tag,
  now,
  onOpen,
}: {
  session: ApiSession
  tag: Tag | undefined
  now: number
  onOpen: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(session.id)}
      className="mx-3 flex min-h-13 w-[calc(100%-24px)] items-center gap-2.5 border-b border-[rgba(150,205,255,.05)] px-2 py-1 text-left opacity-75"
    >
      <PlanetGlyph session={session} offline={false} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="truncate text-[14px] font-semibold text-[rgba(220,235,255,.7)]">{session.title || 'Untitled session'}</span>
        <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">
          <span aria-hidden className="block h-1.5 w-1.5 rounded-full opacity-70" style={{ background: tag ? tagColor(tag.hue) : 'var(--state-neutral)' }} />
          <span className="truncate">{basename(session.cwd)}</span>
        </span>
      </span>
      {session.lastAt !== null && <span className="shrink-0 font-mono text-[11px] text-[rgba(160,190,225,.45)]">{timeAgo(session.lastAt, now)}</span>}
    </button>
  )
}
