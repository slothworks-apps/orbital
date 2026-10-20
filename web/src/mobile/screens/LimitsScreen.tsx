import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { getSocket } from '../../lib/socket'
import type { LimitSeverity, LimitsSnapshot } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { LIMITS_TOPIC } from '@orbital/shared/limits'
import { ClaudeDirMark } from '../../ui/ClaudeDirMark'
import { CLOCK_TICK_MS } from '../constants'
import { phoneLimitsView, type PhoneLimitGroup, type PhoneLimitRow } from '../limits/limitsView'
import { useMobile } from '../state'
import { CARD, MobileScreen } from '../ui'

/** 60d: three steps of one neutral ink, as the desktop's rows — the fill brightens, nothing takes a hue. */
const FILL: Record<LimitSeverity, string> = {
  normal: 'rgba(150,205,255,.42)',
  warning: 'rgba(214,230,248,.72)',
  critical: '#e8eef8',
}

/**
 * Limits on the phone (spec 2026-10-20-limit-suns-design § 5; canvas
 * `Feature - Limit sun` 60d): one section per account, every member of the
 * group asked for its own (`GroupFederation`), read-only apart from Read
 * again. A member that serves the `limits` topic sends what it reads while
 * the screen is open; any other is read on open and on Read again.
 */
export function LimitsScreen() {
  const goBack = useMobile((s) => s.goBack)
  const [snapshot, setSnapshot] = useState<LimitsSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const [reading, setReading] = useState(false)
  const now = useNow(true, CLOCK_TICK_MS)
  // Only the newest answer may land: a read started before a pushed frame must not overwrite it.
  const seq = useRef(0)

  const load = useCallback((refresh: boolean) => {
    const mine = ++seq.current
    if (refresh) setReading(true)
    ;(refresh ? api.refreshLimits() : api.getLimits())
      .then(
        (data) => {
          if (seq.current !== mine) return
          setSnapshot(data)
          setFailed(false)
        },
        () => {
          // No member answered and none was ever read: the screen says so; a kept reading stays as it was.
          if (seq.current === mine) setFailed(true)
        },
      )
      .finally(() => {
        if (refresh) setReading(false)
      })
  }, [])

  useEffect(() => {
    const off = getSocket().subscribe(LIMITS_TOPIC, (msg: { event?: string; limits?: LimitsSnapshot }) => {
      if (msg.event !== 'limits' || !msg.limits) return
      seq.current++
      setSnapshot(msg.limits)
      setFailed(false)
    })
    load(false)
    return off
  }, [load])

  const view = snapshot ? phoneLimitsView(snapshot.dirs, now) : null
  const readAgain = () => {
    if (!reading) load(true)
  }

  const header = (
    // 60d: the 52 px title row, its read time on the right while nothing is out of date.
    <div className="flex h-13 items-center gap-1 border-b border-[rgba(150,205,255,.1)] pl-1.5 pr-4">
      <button
        type="button"
        aria-label="Back"
        onClick={() => goBack()}
        className="grid h-11 w-11 shrink-0 place-items-center text-[28px] leading-none text-[rgba(220,235,255,.85)]"
      >
        ‹
      </button>
      <h1 className="min-w-0 flex-1 text-[17px] font-bold">Limits</h1>
      {view?.read && <span className="font-mono text-[11px] text-[rgba(160,190,225,.55)]">{view.read}</span>}
    </div>
  )

  return (
    <MobileScreen header={header} divider={false}>
      <div className="flex flex-col px-4 pb-4 pt-1">
        {view?.stale && <StaleRow line={view.stale} reading={reading} onReadAgain={readAgain} />}
        {!view && (
          <div className="flex flex-col items-start gap-3 px-1 pt-5">
            <span className="font-mono text-[11px] text-[rgba(160,190,225,.6)]">
              {failed ? 'limits unavailable · no device answered' : 'reading…'}
            </span>
            {failed && <ReadAgainButton reading={reading} onClick={readAgain} />}
          </div>
        )}
        {view?.groups.map((group) => <AccountSection key={group.key} group={group} />)}
      </div>
    </MobileScreen>
  )
}

/** 60d STALE: one row at the top, when the data was last read and who cannot be asked. */
function StaleRow({ line, reading, onReadAgain }: { line: string; reading: boolean; onReadAgain: () => void }) {
  return (
    <div className="mt-3 flex items-center gap-3 rounded-[14px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.7)] py-3 pl-3.5 pr-1.5">
      <span aria-hidden className="block h-4 w-4 shrink-0 rounded-full border border-dashed border-[rgba(200,215,235,.5)]" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-semibold">May be out of date</span>
        <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.65)] [overflow-wrap:anywhere]">{line}</span>
      </span>
      <ReadAgainButton reading={reading} onClick={onReadAgain} />
    </div>
  )
}

function ReadAgainButton({ reading, onClick }: { reading: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={reading}
      className="flex h-11 shrink-0 items-center rounded-[10px] border border-[rgba(150,205,255,.2)] px-3 text-[13px] font-semibold text-text-bright disabled:opacity-60"
    >
      {reading ? 'Reading…' : 'Read again'}
    </button>
  )
}

/** 60d: tiles and e-mail with the plan, the directories and devices on one wrapping mono line, then the windows. */
function AccountSection({ group }: { group: PhoneLimitGroup }) {
  return (
    <section className="flex flex-col">
      <div className="flex flex-col gap-[5px] px-1 pb-2.5 pt-5">
        <div className="flex items-center gap-[7px]">
          {group.tiles.map((mono, i) => (
            <ClaudeDirMark key={i} mono={mono} size="phone" />
          ))}
          <span className="min-w-0 flex-1 text-[15px] font-bold [overflow-wrap:anywhere]">{group.title}</span>
          {group.plan && <span className="shrink-0 font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">{group.plan}</span>}
        </div>
        {group.meta && (
          <div className="font-mono text-[10.5px] leading-[1.55] text-[rgba(160,190,225,.6)] [overflow-wrap:anywhere] [text-wrap:pretty]">
            {group.meta}
          </div>
        )}
      </div>
      {/* 60d STALE: the list dimmed, the values kept — a number labelled as old is still useful. */}
      <div className={[CARD, group.stale ? 'opacity-55' : ''].join(' ')}>
        {group.tracked ? (
          group.rows.map((row, i) => <WindowRow key={row.key} row={row} first={i === 0} />)
        ) : (
          <div className="flex flex-col gap-1 px-3.5 py-3">
            <span className="text-[14px] font-semibold">Limits aren't tracked</span>
            <span className="font-mono text-[11px] leading-normal text-[rgba(160,190,225,.6)]">
              no plan windows · signed in with an API key, or billed as it goes
            </span>
          </div>
        )}
      </div>
    </section>
  )
}

/** 60d: name and value, the bar, then the reset and the estimate, each on its own line. */
function WindowRow({ row, first }: { row: PhoneLimitRow; first: boolean }) {
  return (
    <div
      className={[
        'flex flex-col gap-[7px] border-t px-3.5 pb-3 pt-[13px]',
        first ? 'border-transparent' : 'border-[rgba(150,205,255,.08)]',
      ].join(' ')}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-[14.5px] font-semibold">{row.name}</span>
        {row.word && <span className="font-mono text-[9.5px] tracking-[0.12em] text-[rgba(214,230,248,.8)]">{row.word}</span>}
        <span className="font-mono text-[17px] leading-none">{row.value}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-[2px] bg-[rgba(150,205,255,.1)]">
        <span className="block h-full rounded-[2px]" style={{ width: `${row.width}%`, background: FILL[row.severity] }} />
      </div>
      {(row.reset || row.estimate) && (
        <div className="flex flex-col gap-0.5 font-mono text-[11px] leading-normal">
          {row.reset && (
            <span className="text-[rgba(160,190,225,.6)]">
              resets <span className="text-text-bright">{row.reset}</span>
            </span>
          )}
          {row.estimate && (
            <span style={{ color: row.estimate.lit ? 'rgba(160,190,225,.75)' : 'rgba(160,190,225,.55)' }}>
              {row.estimate.before}
              {row.estimate.at && <span className="text-text-bright">{row.estimate.at}</span>}
              {row.estimate.after}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
