import type { MachineRef } from '@orbital/shared/remote/device';
import type { LimitEstimate } from './estimate.js';

/**
 * The pure half of usage limits (spec 2026-10-03-usage-limits-design): what a
 * limit hit becomes, what a firing wait sends, and how the probe's answer
 * reads as rows. Nothing here touches the database, the SDK or a timer.
 */

/** Past a window's reset, how long a wait gives it before firing. */
export const RESET_GRACE_MS = 60_000;

/** How often the probe reads again while someone has the limits view open. */
export const LIMITS_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * How long after the last session of a directory stopped working its plan
 * is still read in the background: what the last turns spent shows up a
 * little after them.
 */
export const LIMITS_TRAILING_READ_MS = 10 * 60_000;

/** How often the background reading looks at which directories have a session working. */
export const LIMITS_BACKGROUND_TICK_MS = 60_000;

/**
 * Whether the background reading reads a directory's plan now: one seen
 * working within `LIMITS_TRAILING_READ_MS` (epoch ms, null when never),
 * whose last read started `LIMITS_REFRESH_INTERVAL_MS` ago or more.
 */
export function backgroundReadDue(lastWorkingAt: number | null, attemptedAt: number | null, now: number): boolean {
  if (lastWorkingAt === null || now - lastWorkingAt > LIMITS_TRAILING_READ_MS) return false;
  return attemptedAt === null || now - attemptedAt >= LIMITS_REFRESH_INTERVAL_MS;
}

/** Percent at which a window graded by Orbital itself (no server severity) reads `warning`. */
export const WARNING_PERCENT = 75;
/** Percent at which a window graded by Orbital itself reads `critical`. */
export const CRITICAL_PERCENT = 90;

/** The text sent on continue when the setting holds none. */
export const DEFAULT_CONTINUE_TEXT = 'Continue where you left off.';
/** Settings key: continue automatically after a limit reset (`'false'` is off, anything else on). */
export const AUTO_CONTINUE_KEY = 'limits_auto_continue';
/** Settings key: the message sent on continue. */
export const CONTINUE_TEXT_KEY = 'limits_continue_text';

export type LimitSeverity = 'normal' | 'warning' | 'critical';

/** One window of the plan as the limits view lists it. */
export interface LimitWindow {
  kind: string;
  label: string;
  percent: number;
  /** ISO, or null when the server gave none. */
  resetsAt: string | null;
  severity: LimitSeverity;
  /**
   * When it runs out at the current pace (spec 2026-10-20-limit-suns-design
   * § 2): absent from an older server, null when there is none to give.
   */
  estimate?: LimitEstimate | null;
}

export interface ExtraUsage {
  enabled: boolean;
  /** Minor units, as the server gives them. */
  usedCredits: number | null;
  monthlyLimit: number | null;
  percent: number | null;
  currency: string | null;
}

/** A session waiting for a window to reset, as `ApiSession.limitWait` carries it. */
export interface LimitWait {
  /** ISO. */
  resetsAt: string;
  windowKind: string;
  windowLabel: string;
  /** Cancel was pressed for this wait; Undo clears it. */
  cancelled: boolean;
  /** The setting is on and the wait is not cancelled: what fires at the reset when nothing is queued. */
  willContinue: boolean;
  /** Texts the user wrote during the wait, in order. */
  queued: string[];
  /**
   * The auto-continue setting and the continuation text as the wait was
   * published, so a client that cannot read the Mac's settings (the phone)
   * can still word the notice (spec 2026-10-05-mobile-next-design § 5 Server).
   */
  autoContinue: boolean;
  continueText: string;
}

/**
 * What `GET /api/limits` answers: one reading per configured Claude
 * directory, in the directories' order (spec
 * 2026-10-04-multiple-claude-directories-design § 5). Each account has its
 * own plan and its own windows.
 */
export interface LimitsSnapshot {
  dirs: ClaudeDirLimits[];
}

/** One Claude directory's plan limits, and the sessions of it that wait for a reset. */
export interface ClaudeDirLimits {
  /** `claude_dirs.id`, on the device the directory is on. */
  id: number;
  name: string;
  /**
   * The e-mail of the account the directory is signed in to, lower-cased;
   * null when it cannot be read. Directories of one account share one plan
   * (spec 2026-10-20-limit-suns-design § 1).
   */
  account: string | null;
  /**
   * Another member's directory, merged into this device's answer: the member
   * it is on, as its sessions name it. Absent on this device's own, and on
   * every answer to a request that came over a channel.
   */
  machine?: MachineRef;
  /**
   * False with an API key, or when the server says plan limits do not apply
   * — an enterprise account billed by usage has no windows at all.
   */
  tracked: boolean;
  /** ISO of the last good read; null when never read. */
  readAt: string | null;
  /** The last read attempt failed; `windows` are the last good ones. */
  stale: boolean;
  windows: LimitWindow[];
  extraUsage: ExtraUsage | null;
  waits: { sessionId: string; title: string; resetsAt: string; windowLabel: string; willContinue: boolean }[];
}

/** What a rejected `rate_limit_event` told the session. */
export interface RejectedLimit {
  /** Epoch ms, or null when the event carried none. */
  resetsAt: number | null;
  rateLimitType: string | null;
}

/**
 * `resetsAt` off a `rate_limit_event`, as epoch ms. The SDK sends epoch
 * seconds; a value too large to be seconds for any plausible date is already
 * milliseconds and is taken as it is.
 */
export function epochMsOf(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return raw < 1e12 ? raw * 1000 : raw;
}

/**
 * Reads a `rate_limit_event`'s info: a `RejectedLimit` when its status is
 * `rejected`, `'allowed'` when it lets requests through (extra usage covering
 * one included), null when it is not a readable event.
 */
export function readRateLimitInfo(info: unknown): RejectedLimit | 'allowed' | null {
  if (!info || typeof info !== 'object') return null;
  const i = info as Record<string, unknown>;
  if (i.status === 'rejected') {
    return {
      resetsAt: epochMsOf(i.resetsAt),
      rateLimitType: typeof i.rateLimitType === 'string' ? i.rateLimitType : null,
    };
  }
  if (i.status === 'allowed' || i.status === 'allowed_warning') return 'allowed';
  return null;
}

/** Labels for the event's `rateLimitType`. */
const EVENT_LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_overage_included: 'Weekly',
  overage: 'Extra usage',
};

/** The label a wait shows for the window an event named. */
export function labelForRateLimitType(type: string | null): string {
  if (!type) return 'Usage limit';
  return EVENT_LABELS[type] ?? type;
}

/**
 * The probe's kinds each event type corresponds to — the server's row kind
 * and the SDK's fixed window name. Scoped weekly rows also have to match the
 * model named in the type.
 */
const EVENT_TO_PROBE: Record<string, { kinds: string[]; model?: string }> = {
  five_hour: { kinds: ['five_hour', 'session'] },
  seven_day: { kinds: ['seven_day', 'weekly_all'] },
  seven_day_overage_included: { kinds: ['seven_day', 'weekly_all'] },
  seven_day_opus: { kinds: ['seven_day_opus', 'weekly_scoped'], model: 'opus' },
  seven_day_sonnet: { kinds: ['seven_day_sonnet', 'weekly_scoped'], model: 'sonnet' },
};

/** Whether `w` is a probe row of the window an event type names. */
function namesWindow(type: string | null, w: LimitWindow): boolean {
  const want = type ? EVENT_TO_PROBE[type] : undefined;
  if (!want || !want.kinds.includes(w.kind)) return false;
  return !(w.kind === 'weekly_scoped' && want.model && !w.label.toLowerCase().includes(want.model));
}

/** The probe's window an event type names, among `windows`, or null. */
export function probeWindowFor(type: string | null, windows: LimitWindow[]): LimitWindow | null {
  return windows.find((w) => namesWindow(type, w)) ?? null;
}

/** The reset the probe knows for the window an event named, epoch ms, or null. */
export function probeResetFor(type: string | null, windows: LimitWindow[]): number | null {
  for (const w of windows) {
    if (!namesWindow(type, w) || !w.resetsAt) continue;
    const at = Date.parse(w.resetsAt);
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/** What a `rate_limit_event` says of its window's use, when it carries it. */
export interface EventUsage {
  rateLimitType: string;
  percent: number;
  /** Epoch ms, or null when the event carried none. */
  resetsAt: number | null;
}

/**
 * A `rate_limit_event`'s use of its window, or null when it carries no
 * `utilization` or no `rateLimitType`. The SDK does not document the unit;
 * the CLI passes the API header's fraction on as it is (checked in CLI
 * 2.1.280, whose own notice floors `utilization * 100`). Past the limit the
 * fraction exceeds 1, so it is always scaled, never guessed at.
 */
export function readEventUsage(info: unknown): EventUsage | null {
  if (!info || typeof info !== 'object') return null;
  const i = info as Record<string, unknown>;
  const u = i.utilization;
  if (typeof i.rateLimitType !== 'string' || !i.rateLimitType) return null;
  if (typeof u !== 'number' || !Number.isFinite(u) || u < 0) return null;
  return { rateLimitType: i.rateLimitType, percent: u * 100, resetsAt: epochMsOf(i.resetsAt) };
}

/** What a window's readings are kept under: its kind, and its label, which tells scoped weekly windows apart. */
export function windowKeyOf(w: Pick<LimitWindow, 'kind' | 'label'>): string {
  return `${w.kind}|${w.label}`;
}

/** What a wait is made from, before it is stored. */
export interface NewWait {
  /** Epoch ms. */
  resetsAt: number;
  windowKind: string;
  windowLabel: string;
}

/**
 * A main turn's end turned into a wait, or null. Needs both halves: a
 * `rejected` event seen during the turn, and the turn ending on the
 * `rate_limit` error. Without a reset time from the event, `probeReset` is
 * asked; without one from either, nothing is made.
 */
export function waitFromLimitHit(
  rejected: RejectedLimit | null,
  turnError: string | null,
  probeReset: (type: string | null) => number | null,
): NewWait | null {
  if (!rejected || turnError !== 'rate_limit') return null;
  const resetsAt = rejected.resetsAt ?? probeReset(rejected.rateLimitType);
  if (resetsAt === null) return null;
  return {
    resetsAt,
    windowKind: rejected.rateLimitType ?? 'unknown',
    windowLabel: labelForRateLimitType(rejected.rateLimitType),
  };
}

/** One message the user wrote during a wait. */
export interface QueuedMessage {
  text: string;
  attachments?: string[];
}

/**
 * What a firing wait sends, or null for nothing: the queued messages as one
 * turn, always; otherwise the continuation text, only while the setting is on
 * and the wait was not cancelled.
 */
export function whatFiringSends(
  wait: { cancelled: boolean; queued: QueuedMessage[] },
  settings: { autoContinue: boolean; continueText: string },
): { text: string; attachments: string[] } | null {
  if (wait.queued.length > 0) {
    return {
      text: wait.queued.map((q) => q.text).filter((t) => t.length > 0).join('\n\n'),
      attachments: wait.queued.flatMap((q) => q.attachments ?? []),
    };
  }
  if (!settings.autoContinue || wait.cancelled) return null;
  return { text: continueTextOf(settings.continueText), attachments: [] };
}

/** The stored continuation text, or the default when it is blank. */
export function continueTextOf(stored: string): string {
  return stored.trim() ? stored : DEFAULT_CONTINUE_TEXT;
}

/** The setting as stored: on unless it says `'false'`. */
export function autoContinueOf(stored: string): boolean {
  return stored !== 'false';
}

// ---- The probe's answer -------------------------------------------------

/** Labels for the server's row kinds that need no scope. */
const KIND_LABELS: Record<string, string> = {
  session: '5-hour window',
  weekly_all: 'Weekly',
};

/** The SDK's typed fixed windows, in the order they are listed when `limits[]` is missing. */
const FIXED_WINDOWS: [string, string][] = [
  ['five_hour', '5-hour window'],
  ['seven_day', 'Weekly'],
  ['seven_day_opus', 'Weekly · Opus'],
  ['seven_day_sonnet', 'Weekly · Sonnet'],
];

const SEVERITIES: readonly string[] = ['normal', 'warning', 'critical'];

function severityOf(raw: unknown): LimitSeverity {
  return typeof raw === 'string' && SEVERITIES.includes(raw) ? (raw as LimitSeverity) : 'normal';
}

/** Severity for a window the server did not grade. */
export function gradePercent(percent: number): LimitSeverity {
  if (percent >= CRITICAL_PERCENT) return 'critical';
  if (percent >= WARNING_PERCENT) return 'warning';
  return 'normal';
}

function numberOr(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function scopeName(scope: unknown): string | null {
  if (!scope || typeof scope !== 'object') return null;
  const model = (scope as { model?: unknown }).model;
  if (!model || typeof model !== 'object') return null;
  const name = (model as { display_name?: unknown }).display_name;
  return typeof name === 'string' && name ? name : null;
}

/** A server row's label: the known kinds by name, any other as its kind plus its scope. */
export function labelForKind(kind: string, scope: unknown): string {
  const scoped = scopeName(scope);
  if (kind === 'weekly_scoped') return scoped ? `Weekly · ${scoped}` : 'Weekly';
  const known = KIND_LABELS[kind];
  if (known) return known;
  return scoped ? `${kind} · ${scoped}` : kind;
}

/** What the probe's answer says, shaped for the snapshot. */
export interface ProbeReading {
  tracked: boolean;
  windows: LimitWindow[];
  extraUsage: ExtraUsage | null;
  /** When the weekly window started, epoch ms, when the answer said (`seven_day_breakdown.window_started_at`). */
  weeklyStartedAt: number | null;
}

/** The weekly windows `weeklyStartedAt` is the start of: the all-models one, by either name. */
export const WEEKLY_ALL_KINDS: readonly string[] = ['weekly_all', 'seven_day'];

/**
 * The `get_usage` answer as rows. `rate_limits.limits[]` (undeclared in the
 * SDK's types) when present, in the server's order; else the typed fixed
 * windows, graded from their percent.
 */
export function readUsageAnswer(answer: unknown): ProbeReading {
  const a = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
  const limits = a.rate_limits && typeof a.rate_limits === 'object' ? (a.rate_limits as Record<string, unknown>) : null;
  if (a.rate_limits_available === false || !limits) {
    return { tracked: a.rate_limits_available !== false, windows: [], extraUsage: null, weeklyStartedAt: null };
  }

  const windows: LimitWindow[] = [];
  if (Array.isArray(limits.limits)) {
    for (const row of limits.limits) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (typeof r.kind !== 'string' || !r.kind) continue;
      windows.push({
        kind: r.kind,
        label: labelForKind(r.kind, r.scope),
        percent: numberOr(r.percent, 0),
        resetsAt: isoOrNull(r.resets_at),
        severity: severityOf(r.severity),
      });
    }
  } else {
    for (const [kind, label] of FIXED_WINDOWS) {
      const w = limits[kind];
      if (!w || typeof w !== 'object') continue;
      const percent = numberOr((w as Record<string, unknown>).utilization, 0);
      windows.push({
        kind, label, percent,
        resetsAt: isoOrNull((w as Record<string, unknown>).resets_at),
        severity: gradePercent(percent),
      });
    }
  }

  let extraUsage: ExtraUsage | null = null;
  const extra = limits.extra_usage;
  if (extra && typeof extra === 'object') {
    const e = extra as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    extraUsage = {
      enabled: e.is_enabled === true,
      usedCredits: num(e.used_credits),
      monthlyLimit: num(e.monthly_limit),
      percent: num(e.utilization),
      currency: typeof e.currency === 'string' && e.currency ? e.currency : null,
    };
  }
  const breakdown = limits.seven_day_breakdown;
  const started = breakdown && typeof breakdown === 'object' ? (breakdown as Record<string, unknown>).window_started_at : undefined;
  return { tracked: true, windows, extraUsage, weeklyStartedAt: timeMsOf(started) };
}

/** An ISO time or an epoch (seconds or ms, as `epochMsOf` tells them) as epoch ms; null for anything else. */
function timeMsOf(raw: unknown): number | null {
  if (typeof raw === 'number') return epochMsOf(raw);
  const iso = isoOrNull(raw);
  return iso === null ? null : Date.parse(iso);
}
