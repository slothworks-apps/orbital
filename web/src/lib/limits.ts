import type { ExtraUsage, LimitSeverity, LimitWait } from './types'

/**
 * Plan limits on the web side (spec 2026-10-03-usage-limits-design; canvas
 * `Feature - Plan limits` 31a–31d): how a reset time is written, and the
 * words a waiting session wears on the map, in the header and in the
 * transcript.
 *
 * Times are always absolute — never a countdown (`why-orbital`, "Waiting is
 * fine"). Spelled out by hand rather than through `toLocaleString`, so the
 * canvas's "Thu 8 Oct, 09:00" reads the same whatever the system locale.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad = (n: number) => String(n).padStart(2, '0')

/** A reset time taken apart, in local time; null for a missing or unreadable one. */
export interface ResetClock {
  /** Falls on the same local day as `now`. */
  today: boolean
  /** `Thu 8 Oct`. */
  day: string
  /** `09:00`, 24-hour. */
  time: string
}

export function resetClock(iso: string | null | undefined, now: number = Date.now()): ResetClock | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const ref = new Date(now)
  const today =
    at.getFullYear() === ref.getFullYear() && at.getMonth() === ref.getMonth() && at.getDate() === ref.getDate()
  return {
    today,
    day: `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  }
}

/** `15:00` today, `Thu 8 Oct, 09:00` on any other day, `—` when there is none. */
export function formatResetAt(iso: string | null | undefined, now: number = Date.now()): string {
  const clock = resetClock(iso, now)
  if (!clock) return '—'
  return clock.today ? clock.time : `${clock.day}, ${clock.time}`
}

/** The limits table's form: `today 15:00`, else as `formatResetAt`. */
export function formatResetCell(iso: string | null | undefined, now: number = Date.now()): string {
  const clock = resetClock(iso, now)
  if (!clock) return '—'
  return clock.today ? `today ${clock.time}` : `${clock.day}, ${clock.time}`
}

/** The time inside a sentence: `at 15:00` today, `Thu 8 Oct at 09:00` otherwise. */
export function formatResetPhrase(iso: string | null | undefined, now: number = Date.now()): string {
  const clock = resetClock(iso, now)
  if (!clock) return 'at the reset'
  return clock.today ? `at ${clock.time}` : `${clock.day} at ${clock.time}`
}

/** The server's severity, or `normal` for anything Orbital does not know (31d). */
export function limitSeverity(value: string | null | undefined): LimitSeverity {
  return value === 'warning' || value === 'critical' ? value : 'normal'
}

/**
 * The word under a row's value (31d): none for normal, the severity in caps
 * otherwise, and LIMIT REACHED once the window is full whatever the grade.
 */
export function severityWord(severity: LimitSeverity, percent: number | null): string {
  if (percent !== null && percent >= 100) return 'LIMIT REACHED'
  return severity === 'normal' ? '' : severity.toUpperCase()
}

/**
 * Money in the currency's minor units, as 31d writes it: `$18.40`, and a
 * whole amount without its cents (`$50`). An unknown currency code falls
 * back to the bare number.
 */
export function formatMoney(minor: number, currency: string | null): string {
  const major = minor / 100
  const whole = Number.isInteger(major)
  if (currency) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(major)
    } catch {
      // not an ISO code — fall through
    }
  }
  return whole ? String(major) : major.toFixed(2)
}

/** Extra usage's value cell: `$18.40 / $50`, or the spend alone without a cap. */
export function extraUsageValue(extra: ExtraUsage): string | null {
  if (extra.usedCredits === null) return null
  const used = formatMoney(extra.usedCredits, extra.currency)
  return extra.monthlyLimit === null ? used : `${used} / ${formatMoney(extra.monthlyLimit, extra.currency)}`
}

/** The default text a wait sends at the reset (31c). Mirrors the server's. */
export const DEFAULT_CONTINUE_TEXT = 'Continue where you left off.'

/** Settings keys of the LIMITS group (31c). Mirrors the server's. */
export const AUTO_CONTINUE_KEY = 'limits_auto_continue'
export const CONTINUE_TEXT_KEY = 'limits_continue_text'

/** The settings as the web reads them: on unless stored off, the default text when none is stored. */
export function limitSettings(settings: Record<string, string | undefined>): { autoContinue: boolean; text: string } {
  const text = settings[CONTINUE_TEXT_KEY]
  return {
    autoContinue: settings[AUTO_CONTINUE_KEY] !== 'false',
    text: text && text.trim() ? text : DEFAULT_CONTINUE_TEXT,
  }
}

/** What the transcript's notice offers (31d): Cancel while it will continue, Undo once cancelled. */
export type LimitNoticeAction = 'cancel' | 'undo' | null

/**
 * Every word a waiting session wears (31b, 31d — the canvas's own logic).
 * `continues` is the server's `willContinue`: queued messages, or the
 * continuation text with the setting on and the wait not cancelled.
 */
export interface LimitWaitCopy {
  /** Map pill under the name: `waiting for limit · 15:00`, `limit · resets 15:00`. */
  pill: string
  /** Detail header: `WAITING FOR LIMIT · 15:00`, `LIMIT · RESETS 15:00`. */
  status: string
  /** Sidebar row's short column: `LIMIT · 15:00`. */
  short: string
  /** Notice title: `Limit reached, continues at 15:00` / `…, resets at 15:00`. */
  title: string
  /** Notice line under it: the window, then what happens at the reset. */
  sub: string
  action: LimitNoticeAction
  /** The notice links to Settings as well — only while the setting is off. */
  showSettings: boolean
}

export function limitWaitCopy(
  wait: LimitWait,
  settings: { autoContinue: boolean; text: string },
  now: number = Date.now(),
): LimitWaitCopy {
  const at = formatResetAt(wait.resetsAt, now)
  const phrase = formatResetPhrase(wait.resetsAt, now)
  const continues = wait.willContinue
  const queued = wait.queued.length
  const then =
    queued > 0
      ? `then sends ${queued === 1 ? 'your queued message' : `your ${queued} queued messages`}`
      : !settings.autoContinue
        ? 'automatic continue is off'
        : wait.cancelled
          ? 'auto-continue cancelled for this wait'
          : `then sends “${settings.text}”`
  return {
    pill: continues ? `waiting for limit · ${at}` : `limit · resets ${at}`,
    status: continues ? `WAITING FOR LIMIT · ${at}` : `LIMIT · RESETS ${at}`,
    short: `LIMIT · ${at}`,
    title: continues ? `Limit reached, continues ${phrase}` : `Limit reached, resets ${phrase}`,
    sub: `${wait.windowLabel} · ${then}`,
    action: settings.autoContinue ? (wait.cancelled ? 'undo' : 'cancel') : null,
    showSettings: !settings.autoContinue,
  }
}

/** The divider a fired wait folds into (31d AFTER): `LIMIT RESET 15:00 · CONTINUED`. */
export function limitResetLabel(resetsAt: string | undefined, sent: boolean, now: number = Date.now()): string {
  const at = formatResetAt(resetsAt, now)
  return sent ? `LIMIT RESET ${at} · CONTINUED` : `LIMIT RESET ${at}`
}
