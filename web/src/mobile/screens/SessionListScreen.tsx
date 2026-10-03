import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { timeAgo } from '../../lib/format'
import { isReadOnly, sessionStateKey, tagColor, type ApiSession, type Tag } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { useOrbital } from '../../store/store'
import { recheckMac } from '../connect'
import { CLOCK_TICK_MS, RETRY_WINDOW_MS } from '../constants'
import { agoLabel, asOfLabel, basename, checkedLabel } from '../format'
import { GROUP_LABEL, decisionReason, groupSessions, latestActivity, tagChips } from '../sessionList'
import { isMacAsleep, useMobile } from '../state'
import { MobileScreen } from '../ui'
import { Glyph } from './Glyph'

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

  // One bounded presence check, never a loop (spec § 5, RETRY_WINDOW_MS).
  const retry = async () => {
    setChecking(true)
    await recheckMac(RETRY_WINDOW_MS)
    setChecking(false)
  }

  const header = (
    <div className="flex items-center gap-3 px-4 py-2">
      <span className="shrink-0 font-mono text-[10.5px] tracking-[0.2em] text-text-muted">ORBITAL</span>
      <h1 className="truncate text-[17px] font-semibold">{mac}</h1>
      {link === 'connecting' && (
        <span role="img" aria-label="connecting to the relay" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--state-neutral)] opacity-60" />
      )}
      <button type="button" aria-label="Settings" onClick={() => go('settings')} className="ml-auto min-h-11 min-w-11 text-[18px] text-text-muted">
        ⚙
      </button>
    </div>
  )

  return (
    <MobileScreen header={header}>
      {offline && (
        <section className="mx-4 mt-3 rounded-[12px] border border-panel-border bg-[rgba(10,16,28,.7)] px-4 py-3">
          <p className="text-[15px] font-semibold text-text-bright">{mac} is asleep</p>
          <p className="mt-1 text-[13px] text-text-soft">
            Showing what it last sent. Reconnects on its own when the Mac wakes.
          </p>
          <div className="mt-1 flex items-center gap-3 font-mono text-[11px] text-text-muted">
            <span className="min-w-0 truncate">
              {[asOf !== null ? asOfLabel(asOf, now) : null, checkedAt !== null ? checkedLabel(checkedAt, now) : null]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <button type="button" disabled={checking} onClick={() => void retry()} className="ml-auto min-h-11 px-2 text-text-soft disabled:opacity-40">
              Retry
            </button>
          </div>
        </section>
      )}

      {chips.length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-4 pt-3">
          <Chip active={tagId === null} onClick={() => setTagId(null)} label="All" />
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

      {groups.map((group) => {
        const rows = group.sessions.map((s) => (
          <SessionRow key={s.id} session={s} tag={tagById.get(s.tagIds[0])} offline={offline} now={now} onOpen={openSession} />
        ))
        if (group.key === 'ended') {
          const latest = latestActivity(group.sessions)
          return (
            <section key="ended" className="mt-4">
              <button
                type="button"
                aria-expanded={endedOpen}
                onClick={() => setEndedOpen(!endedOpen)}
                className="flex min-h-11 w-full items-center gap-2 px-4 font-mono text-[10.5px] tracking-[0.14em] text-text-muted"
              >
                <span>
                  {GROUP_LABEL.ended} · {group.sessions.length}
                </span>
                {latest !== null && <span>· latest {agoLabel(latest, now)}</span>}
                <span aria-hidden className="ml-auto">
                  {endedOpen ? '▾' : '▸'}
                </span>
              </button>
              {endedOpen && rows}
            </section>
          )
        }
        return (
          <section
            key={group.key}
            className={
              group.key === 'input'
                ? 'mx-3 mt-4 rounded-[12px] border border-[color-mix(in_oklch,var(--state-input)_45%,transparent)]'
                : 'mt-4'
            }
          >
            <div className="px-4 pb-1 pt-3 font-mono text-[10.5px] tracking-[0.14em] text-text-muted">
              {GROUP_LABEL[group.key]} · {group.sessions.length}
            </div>
            {rows}
          </section>
        )
      })}

      {groups.length === 0 && <p className="px-4 pt-10 text-center text-[14px] text-text-muted">No sessions yet.</p>}

      {/* 9d; inert while the Mac is asleep. */}
      <div className="px-4 py-6">
        <button
          type="button"
          disabled={offline}
          onClick={() => go('new')}
          className="min-h-11 w-full rounded-[10px] border border-panel-border text-[15px] text-text-soft disabled:text-text-muted disabled:opacity-60"
        >
          {offline ? `New session · needs ${mac} awake` : '+ New session'}
        </button>
      </div>
    </MobileScreen>
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
        'flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px]',
        active ? 'border-[rgba(89,228,243,.5)] text-text-bright' : 'border-panel-border text-text-muted',
      ].join(' ')}
    >
      {hue !== undefined && <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: tagColor(hue) }} />}
      <span>{label}</span>
      {count !== undefined && <span className="font-mono text-[11px] text-text-muted">{count}</span>}
    </button>
  )
}

function SessionRow({
  session,
  tag,
  offline,
  now,
  onOpen,
}: {
  session: ApiSession
  tag: Tag | undefined
  offline: boolean
  now: number
  onOpen: (id: string) => void
}) {
  const [moonsOpen, setMoonsOpen] = useState(false)
  const reason = sessionStateKey(session) === 'needs_input' ? decisionReason(session.pendingDecision) : null
  return (
    <div>
      <button type="button" onClick={() => onOpen(session.id)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left">
        <span className="pt-[6px]">
          <Glyph session={session} offline={offline} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[15px] text-text-bright">{session.title || 'Untitled session'}</span>
            {isReadOnly(session) && (
              <span className="shrink-0 font-mono text-[9.5px] tracking-[0.1em] text-text-muted">READ-ONLY</span>
            )}
            {session.lastAt !== null && (
              <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">{timeAgo(session.lastAt, now)}</span>
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[11px] text-text-muted">
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: tag ? tagColor(tag.hue) : 'var(--state-neutral)' }}
            />
            <span className="truncate">{basename(session.cwd)}</span>
            {session.git && <span className="truncate">⎇ {session.git.ref}</span>}
          </span>
          {reason && <span className="mt-1 block truncate text-[13px] text-[var(--state-input)]">{reason}</span>}
        </span>
      </button>
      {session.subagents.length > 0 && (
        <div className="pb-1 pl-[42px] pr-4">
          <button
            type="button"
            aria-expanded={moonsOpen}
            onClick={() => setMoonsOpen(!moonsOpen)}
            className="min-h-9 font-mono text-[11px] text-text-muted"
          >
            {session.subagents.length} {session.subagents.length === 1 ? 'subagent' : 'subagents'} {moonsOpen ? '▾' : '▸'}
          </button>
          {moonsOpen && (
            <ul className="pb-2">
              {session.subagents.map((agent) => (
                <li key={agent.id} className="flex gap-2 py-0.5 font-mono text-[11px] text-text-muted">
                  <span className="truncate text-text-soft">{agent.name}</span>
                  <span className="ml-auto shrink-0">{agent.state}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
