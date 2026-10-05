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
import type { ClaudeDirInfo, ClaudeDirLimits, LimitSeverity, LimitsSnapshot, LimitsWaitRow } from '../lib/types'
import { claudeDirDisplayPath, claudeDirMonograms } from '../lib/claudeDirs'
import { ClaudeDirMark } from '../ui/ClaudeDirMark'
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
  const [apiKey, setApiKey] = useState(true)
  /** The directories' paths, accounts and presence for the group heads (Mac only; null until read). */
  const [dirInfo, setDirInfo] = useState<ClaudeDirInfo[] | null>(null)
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
    void api.listClaudeDirs().then(setDirInfo).catch(() => {})
    // Which "not tracked" a directory is: the API key's, or an account
    // without plan windows. Unknown reads as the API key's, the old copy.
    void api
      .getHealth()
      .then((h) => setApiKey(h?.billing !== 'subscription'))
      .catch(() => {})
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

  const dirs = snapshot?.dirs ?? []
  // With one directory the page is 31a as it was; with more, each directory
  // is a group under its own name (spec 2026-10-04-multiple-claude-directories-design § 5).
  const grouped = dirs.length >= 2
  const single = !grouped ? (dirs[0] ?? null) : null
  const headerLine = !snapshot
    ? failed
      ? `limits unavailable — ${failed}`
      : 'reading…'
    : single
      ? readLineOf(single, now)
      : ''
  const waits = dirs.flatMap((d) => d.waits)
  const nothingTracked = dirs.length > 0 && dirs.every((d) => !d.tracked)
  const { autoContinue, text } = limitSettings(settings)
  // 44e: an API key outranks every directory's login, so none has windows —
  // one page-wide note, not one per group.
  const apiKeyForAll = grouped && apiKey && nothingTracked
  const monograms = claudeDirMonograms(dirs)
  const infoOf = (id: number) => dirInfo?.find((d) => d.id === id)
  const dirOfWait = new Map(dirs.flatMap((d) => d.waits.map((w) => [w.sessionId, d.id] as const)))

  return (
    <StatsShell sky="limits" bar={<PageBar route={{ page: 'limits' }} surface="sky" />}>
      <div className="flex min-h-0 flex-1 gap-[18px]">
        {/* 31a: the windows' panel. */}
        <section className="flex min-w-0 flex-1 flex-col overflow-y-auto rounded-[13px] border border-[rgba(150,205,255,.12)] bg-[rgba(6,10,20,.55)] px-7 pb-2 pt-6">
          <div className="flex items-baseline gap-3 pb-[18px]">
            <span className="text-[19px] font-bold text-text-bright">Plan limits</span>
            <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">as reported by Claude</span>
            <span className="flex-1" />
            <span
              className="font-mono text-[10.5px]"
              style={{ color: single?.stale ? 'rgba(220,235,255,.85)' : 'rgba(160,190,225,.55)' }}
            >
              {headerLine}
            </span>
            {single && single.tracked && single.stale && <ReadAgain onClick={readAgain} disabled={reading} />}
          </div>

          {single && <DirWindows dir={single} now={now} apiKey={apiKey} />}

          {apiKeyForAll && <NotTracked apiKey several />}

          {grouped &&
            !apiKeyForAll &&
            dirs.map((dir) => {
              const info = infoOf(dir.id)
              return (
                <div key={dir.id} data-limits-dir={dir.id} className="flex flex-col">
                  {/* 44e's group head: the mark, the name, the account and the path.
                      The read line takes the head's free right end — each
                      directory is read on its own. */}
                  <div className="flex items-center gap-2.5 border-t border-[rgba(150,205,255,.14)] pb-2.5 pt-4">
                    <ClaudeDirMark mono={monograms.get(dir.id) ?? '?'} size="phone" />
                    <span className="min-w-0 truncate text-[14.5px] font-bold text-text-bright">{dir.name}</span>
                    {info && (
                      <span className="flex-none font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">
                        {[info.account, claudeDirDisplayPath(info.path)].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <span className="flex-1" />
                    {info?.exists !== false && (
                      <span
                        className="font-mono text-[10.5px]"
                        style={{ color: dir.stale ? 'rgba(220,235,255,.85)' : 'rgba(160,190,225,.55)' }}
                      >
                        {readLineOf(dir, now)}
                      </span>
                    )}
                    {info?.exists !== false && dir.tracked && dir.stale && (
                      <ReadAgain onClick={readAgain} disabled={reading} />
                    )}
                  </div>
                  {info?.exists === false ? (
                    <QuietRow
                      ring="rgba(200,215,235,.25)"
                      title="Not found on disk"
                      titleInk="rgba(232,238,248,.7)"
                      mono
                      text={`${claudeDirDisplayPath(info.path)} · nothing to read`}
                    />
                  ) : !dir.tracked ? (
                    <QuietRow
                      ring="rgba(200,215,235,.35)"
                      title="Limits not tracked"
                      titleInk="rgba(232,238,248,.85)"
                      text="This account is billed by usage and has no plan windows. Its sessions never wait for a reset."
                    />
                  ) : (
                    <DirWindows dir={dir} now={now} apiKey={apiKey} compact />
                  )}
                </div>
              )
            })}
        </section>

        {/* 31a: the right column. */}
        <div className="flex w-[380px] flex-none flex-col gap-[18px]">
          {nothingTracked ? (
            <Card label="WAITING FOR A RESET">
              <div className="font-mono text-[10.5px] text-[rgba(160,190,225,.5)]">— not tracked</div>
            </Card>
          ) : (
            waits.length > 0 && (
              <Card label="WAITING FOR A RESET">
                {waits.map((wait) => {
                  const dirId = grouped ? dirOfWait.get(wait.sessionId) : undefined
                  return (
                    <WaitRow
                      key={wait.sessionId}
                      wait={wait}
                      now={now}
                      mono={dirId === undefined ? undefined : monograms.get(dirId)}
                    />
                  )
                })}
                {grouped && (
                  <div className="font-mono text-[10px] leading-[1.7] text-[rgba(160,190,225,.5)]">
                    a session waits on its own directory's window only
                  </div>
                )}
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

/** One directory's read line: when it was read, or that it may be out of date. Empty when not tracked. */
function readLineOf(dir: ClaudeDirLimits, now: number): string {
  if (!dir.tracked) return ''
  if (dir.readAt === null) return 'reading…'
  return dir.stale
    ? `last read ${formatResetAt(dir.readAt, now)} — may be out of date`
    : `read ${formatResetAt(dir.readAt, now)}`
}

function ReadAgain({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="ml-1 cursor-pointer rounded-[7px] border border-[rgba(150,205,255,.14)] bg-[rgba(150,205,255,.05)] px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-[rgba(200,220,245,.85)] transition-colors duration-150 hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.12)] hover:text-text-bright disabled:cursor-default"
    >
      READ AGAIN
    </button>
  )
}

/** One directory's windows, or its "not tracked" note. */
function DirWindows({
  dir,
  now,
  apiKey,
  compact = false,
}: {
  dir: ClaudeDirLimits
  now: number
  apiKey: boolean
  compact?: boolean
}) {
  if (!dir.tracked) return <NotTracked apiKey={apiKey} />
  return (
    <div
      className="flex flex-col transition-opacity duration-[250ms] ease-[ease]"
      style={{ opacity: dir.stale ? 0.55 : 1 }}
    >
      {dir.windows.map((w, i) => (
        <WindowRow
          key={`${w.kind}:${w.label}:${i}`}
          name={w.label}
          sub={w.scope ?? null}
          percent={w.percent}
          severity={limitSeverity(w.severity)}
          value={`${Math.round(w.percent)}%`}
          resetsAt={w.resetsAt}
          now={now}
          compact={compact}
        />
      ))}
      {dir.extraUsage?.enabled && (
        <WindowRow
          name="Extra usage"
          sub="spend / monthly cap"
          percent={dir.extraUsage.percent}
          severity="normal"
          value={extraUsageValue(dir.extraUsage) ?? '—'}
          money
          resetsAt={null}
          now={now}
          compact={compact}
        />
      )}
    </div>
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
  compact = false,
}: {
  name: string
  sub: string | null
  percent: number | null
  severity: LimitSeverity
  value: string
  money?: boolean
  resetsAt: string | null
  now: number
  /** 44e: a window inside a directory group, a notch smaller than 31a's page of one. */
  compact?: boolean
}) {
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  const word = severityWord(severity, money ? null : percent)
  return (
    <div
      className={[
        'grid items-center gap-7 border-t',
        compact
          ? 'grid-cols-[200px_minmax(0,1fr)_120px_170px] border-[rgba(150,205,255,.07)] py-3.5'
          : 'grid-cols-[230px_minmax(0,1fr)_120px_190px] border-[rgba(150,205,255,.08)] py-5',
      ].join(' ')}
    >
      <div className="min-w-0">
        <div className={`${compact ? 'text-[13.5px]' : 'text-[14px]'} font-semibold text-text-bright`}>{name}</div>
        {sub && (
          <div className={`${compact ? 'mt-[3px]' : 'mt-1'} font-mono text-[10.5px] text-[rgba(160,190,225,.6)]`}>{sub}</div>
        )}
      </div>
      <div className="relative h-1 overflow-hidden rounded-[2px] bg-[rgba(150,205,255,.1)]">
        <span className="block h-full rounded-[2px]" style={{ width: `${width}%`, background: FILL[severity] }} />
      </div>
      <div className="flex flex-col items-end gap-[5px]">
        <span
          className={`font-mono leading-none text-text-bright ${money ? 'text-[14px]' : compact ? 'text-[18px]' : 'text-[20px]'}`}
        >
          {value}
        </span>
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
function WaitRow({ wait, now, mono }: { wait: LimitsWaitRow; now: number; mono?: string }) {
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
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
          {/* 44e: the waiting session's directory, with two or more. */}
          {mono !== undefined && <ClaudeDirMark mono={mono} />}
          <span className="min-w-0">
            {wait.windowLabel} · {wait.willContinue ? 'continues at reset' : 'stays idle after reset'}
          </span>
        </div>
      </div>
      <span className="font-mono text-[11px] text-text-bright">{formatResetAt(wait.resetsAt, now)}</span>
    </a>
  )
}

/**
 * 31a NOT TRACKED: an API-key login has no plan windows, and neither has an
 * account billed by usage — but that one is said per directory (`QuietRow`).
 * With two or more directories (`several`, 44e) the key overrides every
 * directory's login, and the note says so once for the whole page.
 */
function NotTracked({ apiKey, several = false }: { apiKey: boolean; several?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-3 border-t border-[rgba(150,205,255,.08)] pb-[60px] pl-1">
      <span aria-hidden className="block h-10 w-10 rounded-full border border-dashed border-[rgba(200,215,235,.35)]" />
      <div className="text-[17px] font-bold text-text-bright">Limits aren't tracked</div>
      <div className="max-w-[520px] text-[13px] leading-[1.6] text-[rgba(190,212,238,.75)] [text-wrap:pretty]">
        {apiKey
          ? `Orbital is signed in with an API key. API usage is billed per token and has no plan windows, so there is nothing to show here. ${several ? 'The key overrides the login of every directory, so no directory has limits either.' : 'Sessions never wait for a reset.'}`
          : 'This account has no plan windows — its usage is billed as it goes, so there is nothing to show here. Its sessions never wait for a reset.'}
      </div>
      {apiKey && (
        <div className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
          sign in with a Claude account in Settings → General to track limits
        </div>
      )}
    </div>
  )
}

/**
 * 44e: one quiet line inside a directory group, in place of its windows — an
 * account with no plan windows, or a directory missing on disk. A dashed ring,
 * no amber, no red, no icon.
 */
function QuietRow({
  ring,
  title,
  titleInk,
  text,
  mono = false,
}: {
  ring: string
  title: string
  titleInk: string
  text: string
  mono?: boolean
}) {
  return (
    <div className="flex items-center gap-3 border-t border-[rgba(150,205,255,.07)] pb-4 pt-3.5">
      <span
        aria-hidden
        className="box-border block h-4 w-4 flex-none rounded-full border border-dashed"
        style={{ borderColor: ring }}
      />
      <span className="flex-none text-[13px] font-semibold" style={{ color: titleInk }}>
        {title}
      </span>
      <span
        className={
          mono
            ? 'min-w-0 font-mono text-[11px] text-[rgba(160,190,225,.55)]'
            : 'min-w-0 text-[12.5px] text-[rgba(160,190,225,.7)]'
        }
      >
        {text}
      </span>
    </div>
  )
}
