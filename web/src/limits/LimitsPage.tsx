import { swatch } from '../lib/palette'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { limitSunsEnabled } from '../lib/experimental'
import {
  estimateLine,
  extraUsageValue,
  formatResetAt,
  formatResetCell,
  limitSettings,
  limitSeverity,
  severityWord,
  windowScopeLine,
} from '../lib/limits'
import { sunColors, sunDiscGradient, sunTiles, type SunColor } from '../lib/limitSuns'
import { settingsHref } from '../lib/sessionUrl'
import { useLimitsSnapshot } from '../lib/useLimitsSnapshot'
import { useNow } from '../lib/useNow'
import type { ClaudeDirInfo, ClaudeDirLimits, LimitSeverity, LimitsWaitRow } from '../lib/types'
import { claudeDirMonograms } from '../lib/claudeDirs'
import { ClaudeDirMark } from '../ui/ClaudeDirMark'
import { KindGlyph } from '../ui/KindGlyph'
import { LOCAL_DEVICE } from '../lib/devices'
import { mapHref } from '../walkthrough/route'
import { PageBar } from '../ui/PageBar'
import { StatsShell } from '../stats/StatsShell'
import {
  accountViews,
  estimateWords,
  paceExplanation,
  sunAccountKeys,
  thisDevice,
  UNNAMED_THIS_DEVICE,
  type AccountDevice,
  type AccountDir,
  type AccountView,
  type EstimateWords,
} from './accounts'

/**
 * `/limits` — the plan's usage windows (spec 2026-10-03-usage-limits-design
 * § 2; canvas `Feature - Plan limits` 31a), one group per Claude account
 * (spec 2026-10-20-limit-suns-design § 3; canvas `Feature - Limit sun` 60c).
 * Its own screen, mounted instead of `App` like `/stats`, but with the
 * socket: the server pushes a fresh read on the `limits` topic, and it
 * probes only while someone is subscribed to it — so the subscription
 * (`useLimitsSnapshot`) is what keeps the view current, and leaving or
 * hiding the page is what stops the probe.
 *
 * `account` is the key of the account whose sun opened the page
 * (`/limits/<key>`): the page scrolls to it and lights its head for
 * `OPENED_FROM_MAP_LIT_MS`.
 */
export function LimitsPage({ account = null }: { account?: string | null }) {
  const { snapshot, failed, reading, refresh: readAgain } = useLimitsSnapshot()
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [apiKey, setApiKey] = useState(true)
  /** The directories' paths, accounts and presence for the group heads (Mac only; null until read). */
  const [dirInfo, setDirInfo] = useState<ClaudeDirInfo[] | null>(null)
  /** This device's name for the devices line, as the device chips read it. */
  const [self, setSelf] = useState<AccountDevice | null>(null)
  // Re-read each minute so "today" stops being today at midnight.
  const now = useNow(true, 60_000)

  useEffect(() => {
    void api.getSettings().then(setSettings).catch(() => {})
    void api.listClaudeDirs().then(setDirInfo).catch(() => {})
    void api
      .getRemote()
      .then((remote) => setSelf(thisDevice(remote)))
      .catch(() => {})
    // Which "not tracked" a directory is: the API key's, or an account
    // without plan windows. Unknown reads as the API key's, the old copy.
    void api
      .getHealth()
      .then((h) => setApiKey(h?.billing !== 'subscription'))
      .catch(() => {})
  }, [])

  // Every directory the server knows, the other members' included, grouped
  // by account (spec 2026-10-20-limit-suns-design § 1).
  const dirs = useMemo(() => snapshot?.dirs ?? [], [snapshot])
  const views = useMemo(() => accountViews(dirs, { dirInfo, self, now }), [dirs, dirInfo, self, now])
  // One account in one directory is 31a as it was: nothing is labelled.
  const single = views.length === 1 && views[0].group.entries.length === 1 ? views[0] : null
  const grouped = !single && views.length > 0
  const headerLine = !snapshot
    ? failed
      ? `limits unavailable — ${failed}`
      : 'reading…'
    : single
      ? readLineOf(single, now)
      : ''
  // The waits stay this device's own: a member's session opens on its own map.
  const localDirs = dirs.filter((d) => !d.machine)
  const waits = localDirs.flatMap((d) => d.waits)
  const nothingTracked = dirs.length > 0 && dirs.every((d) => !d.tracked)
  const { autoContinue, text } = limitSettings(settings)
  // 44e: an API key outranks every directory's login, so none has windows —
  // one page-wide note, not one per group.
  const apiKeyForAll = grouped && apiKey && nothingTracked
  // A wait wears its directory's mark with two or more directories here (44e).
  const localMarks = localDirs.length >= 2 ? claudeDirMonograms(localDirs) : null
  const dirOfWait = new Map(localDirs.flatMap((d) => d.waits.map((w) => [w.sessionId, d.id] as const)))
  // The tiles are worth showing once there are two directories to tell apart.
  const showTiles = dirs.length >= 2
  // 60c: the colour dot says which sun is whose, so only while the suns are on.
  const colors = limitSunsEnabled(settings) && !apiKey ? sunColors(sunAccountKeys(views), settings) : null

  // Opened from a sun: scroll to its account once, light the head, let it fade.
  const [lit, setLit] = useState<string | null>(null)
  const landed = useRef(false)
  const litTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(litTimer.current), [])
  useEffect(() => {
    if (!account || landed.current || !snapshot) return
    landed.current = true
    if (single || !views.some((v) => v.group.key === account)) return
    const head = [...document.querySelectorAll<HTMLElement>('[data-limits-account]')].find(
      (el) => el.dataset.limitsAccount === account,
    )
    head?.scrollIntoView({ block: 'start' })
    setLit(account)
    litTimer.current = setTimeout(() => setLit(null), OPENED_FROM_MAP_LIT_MS)
  }, [account, snapshot, single, views])

  return (
    <StatsShell sky="limits" bar={<PageBar route={{ page: 'limits' }} surface="sky" />}>
      <div className="flex min-h-0 flex-1 gap-[18px]">
        {/* 31a / 60c: the windows' panel. */}
        <section className="flex min-w-0 flex-1 flex-col overflow-y-auto rounded-[13px] border border-line/12 bg-shade/55 px-7 pb-2 pt-6">
          <div className={`flex items-baseline gap-3 ${grouped ? 'pb-2.5' : 'pb-[18px]'}`}>
            <span className="fs-19 font-bold text-ink-100">Plan limits</span>
            <span className="font-mono fs-10.5 text-ink-900/55">
              {single?.group.account ? `as reported by Claude · ${single.group.account}` : 'as reported by Claude'}
            </span>
            <span className="flex-1" />
            <span
              className="font-mono fs-10.5"
              style={{ color: single?.stale ? swatch('ink-200', 0.85) : swatch('ink-900', 0.55) }}
            >
              {headerLine}
            </span>
            {single && single.group.reading.tracked && single.stale && (
              <ReadAgain onClick={readAgain} disabled={reading} />
            )}
          </div>

          {single && <DirWindows dir={single.group.reading} stale={single.stale} now={now} apiKey={apiKey} />}

          {apiKeyForAll && <NotTracked apiKey several />}

          {grouped && !apiKeyForAll && (
            <div className="flex flex-col gap-2">
              {views.map((view) => (
                <AccountGroup
                  key={view.group.key}
                  view={view}
                  now={now}
                  apiKey={apiKey}
                  showTiles={showTiles}
                  color={colors?.get(view.group.key) ?? null}
                  lit={lit === view.group.key}
                  reading={reading}
                  onReadAgain={readAgain}
                />
              ))}
            </div>
          )}
        </section>

        {/* 31a / 60c: the right column. */}
        <div className="flex w-[360px] flex-none flex-col gap-[18px]">
          {nothingTracked ? (
            <Card label="WAITING FOR A RESET">
              <div className="font-mono fs-10.5 text-ink-900/50">— not tracked</div>
            </Card>
          ) : (
            waits.length > 0 && (
              <Card label="WAITING FOR A RESET">
                {waits.map((wait) => {
                  const dirId = dirOfWait.get(wait.sessionId)
                  return (
                    <WaitRow
                      key={wait.sessionId}
                      wait={wait}
                      now={now}
                      mono={localMarks && dirId !== undefined ? localMarks.get(dirId) : undefined}
                    />
                  )
                })}
                {localMarks && (
                  <div className="font-mono fs-10 leading-[1.7] text-ink-900/50">
                    a session waits on its own directory's window only
                  </div>
                )}
              </Card>
            )
          )}
          {!nothingTracked && (
            <Card label="AT THIS PACE" gap={10}>
              <div className="fs-12.5 leading-[1.6] text-ink-700/80 [text-wrap:pretty]">
                {paceExplanation()}
              </div>
            </Card>
          )}
          <Card label="AFTER A RESET" gap={10}>
            <div className="fs-12.5 leading-[1.6] text-ink-700/80 [text-wrap:pretty]">
              {autoContinue
                ? `Waiting sessions send “${text}” when their window resets. Cancel it per session in the transcript.`
                : 'Automatic continue is off. Waiting sessions show the reset time and stay idle until you write.'}
            </div>
            <a
              href={settingsHref('sessions')}
              className="font-mono fs-10.5 text-sky no-underline hover:text-sky-soft"
            >
              Settings → Sessions ›
            </a>
          </Card>
        </div>
      </div>
    </StatsShell>
  )
}

/** An account's directories on one device (60c): each name, its path where known, `·` between them. */
function DirRun({ dirs }: { dirs: readonly AccountDir[] }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {dirs.map((d, i) => (
        <Fragment key={d.key}>
          <span className="text-ink-400/88">{d.name}</span>
          {d.path && <span>{d.path}</span>}
          {i < dirs.length - 1 && <span className="text-line/25">·</span>}
        </Fragment>
      ))}
    </span>
  )
}

/** How long the head of the account a sun opened stays lit before it fades (60f, CLICK / DRAG). */
const OPENED_FROM_MAP_LIT_MS = 3000

/**
 * One account (60c): the head — the sun's colour dot, the directory tiles,
 * the e-mail and plan, the read line, the directories and devices it covers
 * — over its windows, or a quiet line in their place.
 */
function AccountGroup({
  view,
  now,
  apiKey,
  showTiles,
  color,
  lit,
  reading,
  onReadAgain,
}: {
  view: AccountView
  now: number
  apiKey: boolean
  showTiles: boolean
  color: SunColor | null
  lit: boolean
  reading: boolean
  onReadAgain: () => void
}) {
  const dir = view.group.reading
  const missing = view.dirs.every((d) => d.missing)
  const { tiles, more } = sunTiles(view.dirs.map((d) => d.mono))
  return (
    <div data-limits-account={view.group.key} className="flex scroll-mt-2 flex-col">
      <div
        className="-mx-3 flex flex-col gap-[7px] rounded-lg border-t border-line/14 px-3 pb-3 pt-4 transition-[background] duration-1000 ease-[ease]"
        style={{ background: lit ? swatch('line', 0.07) : 'transparent' }}
      >
        <div className="flex items-center gap-2">
          <span
            title={color ? 'sun colour' : undefined}
            className="block h-3 w-3 flex-none rounded-full"
            style={{ background: color ? sunDiscGradient(color) : 'transparent' }}
          />
          {showTiles && tiles.map((mono, i) => <ClaudeDirMark key={i} mono={mono} size="phone" />)}
          {showTiles && more > 0 && <ClaudeDirMark mono={`+${more}`} size="phone" />}
          <span className="min-w-0 truncate fs-14.5 font-bold text-ink-100">{view.title}</span>
          {view.plan && (
            <span className="flex-none font-mono fs-10.5 text-ink-900/55">{view.plan}</span>
          )}
          <span className="flex-1" />
          {lit && <span className="font-mono fs-10 text-ink-900/50">opened from the map ·</span>}
          {!missing && (
            <span
              className="font-mono fs-10.5"
              style={{ color: view.stale ? swatch('ink-200', 0.85) : swatch('ink-900', 0.55) }}
            >
              {readLineOf(view, now)}
            </span>
          )}
          {!missing && dir.tracked && view.stale && <ReadAgain onClick={onReadAgain} disabled={reading} />}
        </div>
        {view.devices.length > 0 ? (
          // 60c: a row per device — its glyph and name, then its directories.
          <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-[5px] font-mono fs-10.5 text-ink-900/65">
            {view.devices.map((device) => (
              <Fragment key={device.id}>
                <span className="flex items-center gap-[5px] whitespace-nowrap text-ink-900/55">
                  <KindGlyph kind={device.kind} />
                  {device.name}
                  {device.id === LOCAL_DEVICE && device.name !== UNNAMED_THIS_DEVICE && (
                    <span className="text-ink-900/40">
                      {device.kind === 'desktop' ? '(this Mac)' : '(this device)'}
                    </span>
                  )}
                </span>
                <DirRun dirs={device.dirs} />
              </Fragment>
            ))}
          </div>
        ) : (
          <div className="font-mono fs-10.5 text-ink-900/65">
            <DirRun dirs={view.dirs} />
          </div>
        )}
      </div>
      {missing ? (
        <QuietRow
          ring={swatch('ink-600', 0.25)}
          title="Not found on disk"
          titleInk={swatch('ink-100', 0.7)}
          mono
          text={`${view.dirs.map((d) => d.path).filter(Boolean).join(' · ')} · nothing to read`}
        />
      ) : !dir.tracked ? (
        <QuietRow
          ring={swatch('ink-600', 0.35)}
          title="Limits not tracked"
          titleInk={swatch('ink-100', 0.85)}
          text="Claude reports no plan windows for this account. Its sessions never wait for a reset."
        />
      ) : (
        <DirWindows dir={dir} stale={view.stale} now={now} apiKey={apiKey} compact />
      )}
    </div>
  )
}

/** One account's read line: when it was read, or that it may be out of date. Empty when not tracked. */
function readLineOf(view: AccountView, now: number): string {
  const dir = view.group.reading
  if (!dir.tracked) return ''
  if (dir.readAt === null) return 'reading…'
  return view.stale
    ? `last read ${formatResetAt(dir.readAt, now)} — may be out of date`
    : `read ${formatResetAt(dir.readAt, now)}`
}

function ReadAgain({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="ml-1 cursor-pointer rounded-[7px] border border-line/14 bg-line/5 px-2.5 py-1 font-mono fs-10 tracking-[0.12em] text-ink-500/85 transition-colors duration-150 hover:border-line/30 hover:bg-line/12 hover:text-ink-100 disabled:cursor-default"
    >
      READ AGAIN
    </button>
  )
}

/** One account's windows, or its "not tracked" note. `stale` is the reading's (`limitsReadingStale`). */
function DirWindows({
  dir,
  stale,
  now,
  apiKey,
  compact = false,
}: {
  dir: ClaudeDirLimits
  stale: boolean
  now: number
  apiKey: boolean
  compact?: boolean
}) {
  if (!dir.tracked) return <NotTracked apiKey={apiKey} />
  return (
    <div
      className="flex flex-col transition-opacity duration-[250ms] ease-[ease]"
      style={{ opacity: stale ? 0.55 : 1 }}
    >
      {dir.windows.map((w, i) => (
        <WindowRow
          key={`${w.kind}:${w.label}:${i}`}
          name={w.label}
          sub={w.scope ?? windowScopeLine(w.kind)}
          percent={w.percent}
          severity={limitSeverity(w.severity)}
          value={`${Math.round(w.percent)}%`}
          resetsAt={w.resetsAt}
          estimate={estimateOf(w, stale, now)}
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
          estimate={null}
          now={now}
          compact={compact}
        />
      )}
    </div>
  )
}

function estimateOf(window: ClaudeDirLimits['windows'][number], stale: boolean, now: number): EstimateWords | null {
  const line = estimateLine(window, stale, now)
  return line && estimateWords(line)
}

/** 31d: three steps of one neutral ink — the fill brightens, nothing takes a hue. */
const FILL: Record<LimitSeverity, string> = {
  normal: swatch('line', 0.42),
  warning: swatch('ink-400', 0.72),
  critical: swatch('ink-100'),
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
  estimate,
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
  /** 60c: the run-out estimate under the bar; null for none. */
  estimate: EstimateWords | null
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
          ? 'grid-cols-[200px_minmax(0,1fr)_120px_170px] border-line/7 py-3.5'
          : 'grid-cols-[230px_minmax(0,1fr)_120px_190px] border-line/8 py-5',
      ].join(' ')}
    >
      <div className="min-w-0">
        <div className={`${compact ? 'fs-13.5' : 'fs-14'} font-semibold text-ink-100`}>{name}</div>
        {sub && (
          <div className={`${compact ? 'mt-[3px]' : 'mt-1'} font-mono fs-10.5 text-ink-900/60`}>{sub}</div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="relative h-1 overflow-hidden rounded-[2px] bg-line/10">
          <span className="block h-full rounded-[2px]" style={{ width: `${width}%`, background: FILL[severity] }} />
        </div>
        {estimate && (
          <span
            className="font-mono fs-10.5"
            style={{ color: estimate.lit ? swatch('ink-900', 0.75) : swatch('ink-900', 0.55) }}
          >
            {estimate.before}
            {estimate.at && <span className="text-ink-100">{estimate.at}</span>}
            {estimate.after}
          </span>
        )}
      </div>
      <div className="flex flex-col items-end gap-[5px]">
        <span
          className={`font-mono leading-none text-ink-100 ${money ? 'fs-14' : compact ? 'fs-18' : 'fs-20'}`}
        >
          {value}
        </span>
        {word && <span className="font-mono fs-9.5 tracking-[0.14em] text-ink-400/80">{word}</span>}
      </div>
      <div className="flex flex-col gap-1 font-mono fs-11">
        <span className="text-ink-900/55">{resetsAt ? 'resets' : 'reset'}</span>
        <span className="text-ink-100">{formatResetCell(resetsAt, now)}</span>
      </div>
    </div>
  )
}

function Card({ label, gap = 12, children }: { label: string; gap?: number; children: ReactNode }) {
  return (
    <div
      className="flex flex-col rounded-[13px] border border-line/12 bg-shade/55 px-6 py-[22px]"
      style={{ gap }}
    >
      <span className="font-mono fs-9.5 tracking-[0.2em] text-ink-900/60">{label}</span>
      {children}
    </div>
  )
}

/** A session waiting for a reset; opens it on the map. */
function WaitRow({ wait, now, mono }: { wait: LimitsWaitRow; now: number; mono?: string }) {
  return (
    <a
      href={mapHref(wait.sessionId)}
      className="flex items-center gap-2.5 rounded-[9px] border border-line/10 bg-shade/45 px-3 py-2.5 text-ink-100 no-underline transition-colors duration-150 hover:border-line/20"
    >
      <span
        aria-hidden
        className="block h-[7px] w-[7px] flex-none rounded-full border-[1.5px] border-solid border-ink-400/80"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate fs-13 font-semibold">{wait.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 font-mono fs-10.5 text-ink-900/65">
          {/* 44e: the waiting session's directory, with two or more. */}
          {mono !== undefined && <ClaudeDirMark mono={mono} />}
          <span className="min-w-0">
            {wait.windowLabel} · {wait.willContinue ? 'continues at reset' : 'stays idle after reset'}
          </span>
        </div>
      </div>
      <span className="font-mono fs-11 text-ink-100">{formatResetAt(wait.resetsAt, now)}</span>
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
    <div className="flex flex-1 flex-col items-start justify-center gap-3 border-t border-line/8 pb-[60px] pl-1">
      <span aria-hidden className="block h-10 w-10 rounded-full border border-dashed border-ink-600/35" />
      <div className="fs-17 font-bold text-ink-100">Limits aren't tracked</div>
      <div className="max-w-[520px] fs-13 leading-[1.6] text-ink-700/75 [text-wrap:pretty]">
        {apiKey
          ? `Orbital is signed in with an API key. API usage is billed per token and has no plan windows, so there is nothing to show here. ${several ? 'The key overrides the login of every directory, so no directory has limits either.' : 'Sessions never wait for a reset.'}`
          : 'This account has no plan windows — its usage is billed as it goes, so there is nothing to show here. Its sessions never wait for a reset.'}
      </div>
      {apiKey && (
        <div className="font-mono fs-10.5 text-ink-900/60">
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
    <div className="flex items-center gap-3 border-t border-line/7 pb-4 pt-3.5">
      <span
        aria-hidden
        className="box-border block h-4 w-4 flex-none rounded-full border border-dashed"
        style={{ borderColor: ring }}
      />
      <span className="flex-none fs-13 font-semibold" style={{ color: titleInk }}>
        {title}
      </span>
      <span
        className={
          mono
            ? 'min-w-0 font-mono fs-11 text-ink-900/55'
            : 'min-w-0 fs-12.5 text-ink-900/70'
        }
      >
        {text}
      </span>
    </div>
  )
}
