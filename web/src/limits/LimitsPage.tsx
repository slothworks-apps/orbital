import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { getSocket } from '../lib/socket'
import {
  extraUsageValue,
  formatResetAt,
  formatResetCell,
  limitSettings,
  limitSeverity,
  severityWord,
} from '../lib/limits'
import { settingsHref } from '../lib/sessionUrl'
import { useNow } from '../lib/useNow'
import type { LimitSeverity, LimitsSnapshot, LimitsWaitRow } from '../lib/types'
import { mapHref } from '../walkthrough/route'
import { PageBar } from '../ui/PageBar'
import { StatsShell } from '../stats/StatsShell'

/**
 * `/limits` — the plan's usage windows (spec 2026-10-03-usage-limits-design
 * § 2; canvas `Feature - Plan limits` 31a). Its own screen, mounted instead
 * of `App` like `/stats`, but with the socket: the server pushes a fresh
 * read on the `limits` topic, and it probes only while someone is
 * subscribed to it — so the subscription is what keeps the view current, and
 * leaving the page is what stops the probe.
 */
export function LimitsPage() {
  const [snapshot, setSnapshot] = useState<LimitsSnapshot | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [settings, setSettings] = useState<Record<string, string>>({})
  // Re-read each minute so "today" stops being today at midnight.
  const now = useNow(true, 60_000)

  // Only the newest answer may land: a GET started before a pushed frame
  // must not overwrite it with an older read.
  const seq = useRef(0)
  const load = useCallback(() => {
    const mine = ++seq.current
    api.getLimits().then(
      (data) => {
        if (seq.current !== mine) return
        setSnapshot(data)
        setFailed(null)
      },
      (err: unknown) => {
        if (seq.current === mine) setFailed(err instanceof Error ? err.message || 'request failed' : String(err))
      },
    )
  }, [])

  useEffect(() => {
    const socket = getSocket()
    const off = socket.subscribe('limits', (msg: { event?: string; limits?: LimitsSnapshot }) => {
      if (msg.event !== 'limits' || !msg.limits) return
      seq.current++
      setSnapshot(msg.limits)
      setFailed(null)
    })
    // The first open is the initial fetch; every reopen may have missed a frame.
    const offStatus = socket.onStatusChange((status) => {
      if (status === 'open') load()
    })
    return () => {
      off()
      offStatus()
    }
  }, [load])

  useEffect(() => {
    void api.getSettings().then(setSettings).catch(() => {})
  }, [])

  const readAgain = () => {
    if (reading) return
    setReading(true)
    const mine = ++seq.current
    api
      .refreshLimits()
      .then((data) => {
        if (seq.current === mine) setSnapshot(data)
      })
      .catch(() => {
        // The server records a failed read and marks the answer stale; the
        // page says so through the snapshot, not through a banner.
      })
      .finally(() => setReading(false))
  }

  const tracked = snapshot?.tracked ?? true
  const stale = snapshot?.stale ?? false
  const readLine = !snapshot
    ? failed
      ? `limits unavailable — ${failed}`
      : 'reading…'
    : !tracked
      ? ''
      : snapshot.readAt === null
        ? 'reading…'
        : stale
          ? `last read ${formatResetAt(snapshot.readAt, now)} — may be out of date`
          : `read ${formatResetAt(snapshot.readAt, now)}`
  const { autoContinue, text } = limitSettings(settings)

  return (
    <StatsShell sky="limits" bar={<PageBar route={{ page: 'limits' }} surface="sky" />}>
      <div className="flex min-h-0 flex-1 gap-[18px]">
        {/* 31a: the windows' panel. */}
        <section className="flex min-w-0 flex-1 flex-col rounded-[13px] border border-[rgba(150,205,255,.12)] bg-[rgba(6,10,20,.55)] px-7 pb-2 pt-6">
          <div className="flex items-baseline gap-3 pb-[18px]">
            <span className="text-[19px] font-bold text-text-bright">Plan limits</span>
            <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">as reported by Claude</span>
            <span className="flex-1" />
            <span
              className="font-mono text-[10.5px]"
              style={{ color: stale ? 'rgba(220,235,255,.85)' : 'rgba(160,190,225,.55)' }}
            >
              {readLine}
            </span>
            {tracked && stale && (
              <button
                type="button"
                onClick={readAgain}
                disabled={reading}
                className="ml-1 cursor-pointer rounded-[7px] border border-[rgba(150,205,255,.14)] bg-[rgba(150,205,255,.05)] px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-[rgba(200,220,245,.85)] transition-colors duration-150 hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.12)] hover:text-text-bright disabled:cursor-default"
              >
                READ AGAIN
              </button>
            )}
          </div>

          {snapshot && tracked && (
            <div
              className="flex flex-col transition-opacity duration-[250ms] ease-[ease]"
              style={{ opacity: stale ? 0.55 : 1 }}
            >
              {snapshot.windows.map((w, i) => (
                <WindowRow
                  key={`${w.kind}:${w.label}:${i}`}
                  name={w.label}
                  sub={w.scope ?? null}
                  percent={w.percent}
                  severity={limitSeverity(w.severity)}
                  value={`${Math.round(w.percent)}%`}
                  resetsAt={w.resetsAt}
                  now={now}
                />
              ))}
              {snapshot.extraUsage?.enabled && (
                <WindowRow
                  name="Extra usage"
                  sub="spend / monthly cap"
                  percent={snapshot.extraUsage.percent}
                  severity="normal"
                  value={extraUsageValue(snapshot.extraUsage) ?? '—'}
                  money
                  resetsAt={null}
                  now={now}
                />
              )}
            </div>
          )}

          {snapshot && !tracked && <NotTracked />}
        </section>

        {/* 31a: the right column. */}
        <div className="flex w-[380px] flex-none flex-col gap-[18px]">
          {snapshot && !tracked ? (
            <Card label="WAITING FOR A RESET">
              <div className="font-mono text-[10.5px] text-[rgba(160,190,225,.5)]">— not tracked</div>
            </Card>
          ) : (
            snapshot &&
            snapshot.waits.length > 0 && (
              <Card label="WAITING FOR A RESET">
                {snapshot.waits.map((wait) => (
                  <WaitRow key={wait.sessionId} wait={wait} now={now} />
                ))}
              </Card>
            )
          )}
          <Card label="AFTER A RESET" gap={10}>
            <div className="text-[12.5px] leading-[1.6] text-[rgba(190,212,238,.8)] [text-wrap:pretty]">
              {autoContinue
                ? `Waiting sessions send “${text}” when their window resets. Cancel it per session in the transcript.`
                : 'Automatic continue is off. Waiting sessions show the reset time and stay idle until you write.'}
            </div>
            <a
              href={settingsHref('sessions')}
              className="font-mono text-[10.5px] text-[#8fd8ff] no-underline hover:text-[#c6ecff]"
            >
              Settings → Sessions ›
            </a>
          </Card>
        </div>
      </div>
    </StatsShell>
  )
}

/** 31d: three steps of one neutral ink — the fill brightens, nothing takes a hue. */
const FILL: Record<LimitSeverity, string> = {
  normal: 'rgba(150,205,255,.42)',
  warning: 'rgba(214,230,248,.72)',
  critical: '#e8eef8',
}

/** One window (31a's grid: name · bar · value · reset). */
function WindowRow({
  name,
  sub,
  percent,
  severity,
  value,
  money = false,
  resetsAt,
  now,
}: {
  name: string
  sub: string | null
  percent: number | null
  severity: LimitSeverity
  value: string
  money?: boolean
  resetsAt: string | null
  now: number
}) {
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  const word = severityWord(severity, money ? null : percent)
  return (
    <div className="grid grid-cols-[230px_minmax(0,1fr)_120px_190px] items-center gap-7 border-t border-[rgba(150,205,255,.08)] py-5">
      <div className="min-w-0">
        <div className="text-[14px] font-semibold text-text-bright">{name}</div>
        {sub && <div className="mt-1 font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">{sub}</div>}
      </div>
      <div className="relative h-1 overflow-hidden rounded-[2px] bg-[rgba(150,205,255,.1)]">
        <span className="block h-full rounded-[2px]" style={{ width: `${width}%`, background: FILL[severity] }} />
      </div>
      <div className="flex flex-col items-end gap-[5px]">
        <span className={`font-mono leading-none text-text-bright ${money ? 'text-[14px]' : 'text-[20px]'}`}>{value}</span>
        {word && <span className="font-mono text-[9.5px] tracking-[0.14em] text-[rgba(214,230,248,.8)]">{word}</span>}
      </div>
      <div className="flex flex-col gap-1 font-mono text-[11px]">
        <span className="text-[rgba(160,190,225,.55)]">{resetsAt ? 'resets' : 'reset'}</span>
        <span className="text-text-bright">{formatResetCell(resetsAt, now)}</span>
      </div>
    </div>
  )
}

function Card({ label, gap = 12, children }: { label: string; gap?: number; children: ReactNode }) {
  return (
    <div
      className="flex flex-col rounded-[13px] border border-[rgba(150,205,255,.12)] bg-[rgba(6,10,20,.55)] px-6 py-[22px]"
      style={{ gap }}
    >
      <span className="font-mono text-[9.5px] tracking-[0.2em] text-[rgba(160,190,225,.6)]">{label}</span>
      {children}
    </div>
  )
}

/** A session waiting for a reset; opens it on the map. */
function WaitRow({ wait, now }: { wait: LimitsWaitRow; now: number }) {
  return (
    <a
      href={mapHref(wait.sessionId)}
      className="flex items-center gap-2.5 rounded-[9px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-3 py-2.5 text-text-bright no-underline transition-colors duration-150 hover:border-[rgba(150,205,255,.2)]"
    >
      <span
        aria-hidden
        className="block h-[7px] w-[7px] flex-none rounded-full border-[1.5px] border-solid border-[rgba(214,230,248,.8)]"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold">{wait.title}</div>
        <div className="mt-0.5 font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
          {wait.windowLabel} · {wait.willContinue ? 'continues at reset' : 'stays idle after reset'}
        </div>
      </div>
      <span className="font-mono text-[11px] text-text-bright">{formatResetAt(wait.resetsAt, now)}</span>
    </a>
  )
}

/** 31a NOT TRACKED: an API-key login has no plan windows. */
function NotTracked() {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-3 border-t border-[rgba(150,205,255,.08)] pb-[60px] pl-1">
      <span aria-hidden className="block h-10 w-10 rounded-full border border-dashed border-[rgba(200,215,235,.35)]" />
      <div className="text-[17px] font-bold text-text-bright">Limits aren't tracked</div>
      <div className="max-w-[520px] text-[13px] leading-[1.6] text-[rgba(190,212,238,.75)] [text-wrap:pretty]">
        Orbital is signed in with an API key. API usage is billed per token and has no plan windows, so there is nothing
        to show here. Sessions never wait for a reset.
      </div>
      <div className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
        sign in with a Claude account in Settings → General to track limits
      </div>
    </div>
  )
}
