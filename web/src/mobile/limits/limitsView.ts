import { accountViews, estimateWords, type EstimateWords } from '../../limits/accounts'
import {
  estimateLine, extraUsageValue, formatResetAt, formatResetCell, limitSeverity, severityWord,
} from '../../lib/limits'
import type { ClaudeDirLimits, LimitSeverity } from '../../lib/types'
import { UNNAMED_MAC } from '../composer'

/**
 * The phone's Limits screen (spec 2026-10-20-limit-suns-design § 5; canvas
 * `Feature - Limit sun` 60d): the desktop's page by account, read-only, as a
 * phone reads it. Pure; `screens/LimitsScreen` draws it.
 */

/** One window's row (60d): name and value, the bar, the reset line and the estimate line. */
export interface PhoneLimitRow {
  key: string
  name: string
  /** `64%`, or the money for extra usage. */
  value: string
  /** LIMIT REACHED, CRITICAL, WARNING; empty when normal. */
  word: string
  /** The bar's fill, 0–100. */
  width: number
  severity: LimitSeverity
  /** `today 15:00`, `Thu 8 Oct, 09:00`; null for a row that resets with no window (extra usage). */
  reset: string | null
  /** Null for none: an older Mac, an unknown window, extra usage. */
  estimate: EstimateWords | null
}

/** One account's section (60d). */
export interface PhoneLimitGroup {
  key: string
  /** The directories' monograms; none with a single account on the screen. */
  tiles: string[]
  /** The account's e-mail, else the directory's name. */
  title: string
  plan: string | null
  /** The directories, by device once there are two (60d): `studio-mbp: Work · build-box: Oncall, Work`. */
  meta: string
  stale: boolean
  /** False under an API key, or for an account with no plan windows. */
  tracked: boolean
  rows: PhoneLimitRow[]
}

/** What the screen shows: the sections, and either the read time or the stale row. */
export interface PhoneLimitsView {
  groups: PhoneLimitGroup[]
  /** The header's `read 13:42`, while nothing is out of date; null otherwise. */
  read: string | null
  /** The stale row's line (`last read 09:12 · studio-mbp offline`), while any reading is out of date. */
  stale: string | null
}

export function phoneLimitsView(dirs: readonly ClaudeDirLimits[], now: number): PhoneLimitsView {
  const views = accountViews(dirs, { dirInfo: null, self: null, now })
  const several = views.length >= 2
  const groups = views.map((view): PhoneLimitGroup => {
    const reading = view.group.reading
    const rows: PhoneLimitRow[] = reading.windows.map((w, i) => {
      const severity = limitSeverity(w.severity)
      const line = estimateLine(w, view.stale, now)
      return {
        key: `${w.kind}:${w.label}:${i}`,
        name: w.label,
        value: `${Math.round(w.percent)}%`,
        word: severityWord(severity, w.percent),
        width: Math.max(0, Math.min(100, w.percent)),
        severity,
        reset: formatResetCell(w.resetsAt, now),
        estimate: line && estimateWords(line),
      }
    })
    const extra = reading.extraUsage
    if (extra?.enabled) {
      const severity = limitSeverity(null)
      rows.push({
        key: 'extra',
        name: 'Extra usage',
        value: extraUsageValue(extra) ?? '—',
        word: severityWord(severity, null),
        width: Math.max(0, Math.min(100, extra.percent ?? 0)),
        severity,
        reset: null,
        estimate: null,
      })
    }
    const names = (dirs: typeof view.dirs) => dirs.map((d) => d.name).filter(Boolean).join(', ')
    const meta =
      view.devices.length > 0
        ? view.devices.map((d) => `${d.name || UNNAMED_MAC}: ${names(d.dirs)}`).join(' · ')
        : names(view.dirs)
    return {
      key: view.group.key,
      tiles: several ? unique(view.dirs.map((d) => d.mono)) : [],
      title: view.title,
      plan: view.plan,
      meta,
      stale: view.stale,
      tracked: reading.tracked,
      rows,
    }
  })

  const staleViews = views.filter((v) => v.stale)
  if (staleViews.length === 0) {
    const latest = readTimes(views).at(-1)
    return { groups, read: latest !== undefined ? `read ${clock(latest, now)}` : null, stale: null }
  }
  // The oldest reading of what is out of date, and the devices that cannot be asked.
  const oldest = readTimes(staleViews)[0]
  const offline: string[] = []
  for (const view of staleViews) {
    for (const entry of view.group.entries) {
      const name = entry.machine && !entry.machine.online ? entry.machine.name || UNNAMED_MAC : null
      if (name && !offline.includes(name)) offline.push(name)
    }
  }
  const parts = [
    oldest !== undefined ? `last read ${clock(oldest, now)}` : 'never read',
    ...(offline.length > 0 ? [`${offline.join(', ')} offline`] : []),
  ]
  return { groups, read: null, stale: parts.join(' · ') }
}

/** The readings' times, oldest first; a group never read has none. */
function readTimes(views: readonly { group: { reading: { readAt: string | null } } }[]): number[] {
  return views
    .map((v) => (v.group.reading.readAt === null ? NaN : Date.parse(v.group.reading.readAt)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
}

/** `09:12` today, `Thu 8 Oct, 09:12` on another day. */
function clock(at: number, now: number): string {
  return formatResetAt(new Date(at).toISOString(), now)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
