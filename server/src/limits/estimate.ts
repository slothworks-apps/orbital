/**
 * When a plan window runs out at the current pace (spec
 * 2026-10-20-limit-suns-design § 2). The server's usage answer gives each
 * window only a percent and a reset time, so the pace is Orbital's own: the
 * slope over the recent readings, or the window's average until there are
 * enough of them. Pure: the readings come in, nothing is read or stored.
 */

/** The 5-hour window's length. */
export const FIVE_HOUR_WINDOW_MS = 5 * 3_600_000;
/** The weekly windows' length. */
export const WEEKLY_WINDOW_MS = 7 * 86_400_000;

/** How far back the recent pace of the 5-hour window looks. */
export const FIVE_HOUR_PACE_LOOKBACK_MS = 60 * 60_000;
/** How far back the recent pace of a weekly window looks. */
export const WEEKLY_PACE_LOOKBACK_MS = 12 * 3_600_000;
/** The fewest readings within the lookback a slope is drawn from. */
export const PACE_MIN_READINGS = 3;
/** The share of the lookback the readings of a slope must span, first to last. */
export const PACE_MIN_SPAN_SHARE = 0.25;

/**
 * A reading older than this gives no estimate: nothing has read the window
 * for a while (no session works, nobody watches), so the pace is not known
 * to hold.
 */
export const ESTIMATE_MAX_AGE_MS = 30 * 60_000;

/** Two reset times this close apart are the same window (the server's and the event's are rounded differently). */
export const SAME_WINDOW_TOLERANCE_MS = 10 * 60_000;
/**
 * A percent this much below the one before it is a drop: the window was
 * reset or moved, and what was read before it no longer counts. Smaller
 * differences are the two sources' rounding.
 */
export const PERCENT_DROP_TOLERANCE = 1;

/** One past reading of a window. Times are epoch ms. */
export interface PercentReading {
  percent: number;
  at: number;
  /** The window's reset as read then; null when none was given. */
  resetsAt: number | null;
}

/**
 * A window's run-out estimate, on `LimitWindow.estimate`. `runsOutAt` is
 * ISO when the limit runs out before the reset at this pace, null when it
 * lasts until the reset. `basis` says which pace: `recent`, the slope over
 * the readings within the lookback; `window`, the window's average so far.
 */
export interface LimitEstimate {
  runsOutAt: string | null;
  basis: 'recent' | 'window';
}

/** What is estimated: the window as last read, and when. */
export interface EstimateInput {
  kind: string;
  percent: number;
  /** Epoch ms; null when the server gave none. */
  resetsAt: number | null;
  /** Epoch ms of the reading. */
  readAt: number;
  /** When the window started, epoch ms, when the answer said (`seven_day_breakdown.window_started_at`). */
  startedAt?: number | null;
  /** The last read failed. */
  stale: boolean;
  now: number;
}

/** A window kind's length, or null for a kind whose length is not known. */
export function windowLengthOf(kind: string): number | null {
  if (kind === 'session' || kind === 'five_hour') return FIVE_HOUR_WINDOW_MS;
  if (kind === 'weekly_all' || kind === 'weekly_scoped' || kind.startsWith('seven_day')) return WEEKLY_WINDOW_MS;
  return null;
}

function lookbackOf(length: number): number {
  return length === FIVE_HOUR_WINDOW_MS ? FIVE_HOUR_PACE_LOOKBACK_MS : WEEKLY_PACE_LOOKBACK_MS;
}

/** Whether two reset times name the same window. */
export function sameWindow(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) <= SAME_WINDOW_TOLERANCE_MS;
}

/**
 * The estimate for one window, or null when there is none to give: a stale
 * or old reading, no reset, a kind of unknown length, the limit already
 * reached, or a run-out that would already be past.
 */
export function estimateRunOut(input: EstimateInput, history: readonly PercentReading[]): LimitEstimate | null {
  const { percent, resetsAt, readAt, now } = input;
  if (input.stale || resetsAt === null || !Number.isFinite(percent) || percent < 0 || percent >= 100) return null;
  if (now - readAt > ESTIMATE_MAX_AGE_MS || readAt >= resetsAt) return null;
  const length = windowLengthOf(input.kind);
  if (length === null) return null;

  const nominalStart = resetsAt - length;
  const told = input.startedAt;
  const start = typeof told === 'number' && told >= nominalStart - SAME_WINDOW_TOLERANCE_MS && told < readAt ? told : nominalStart;
  const elapsed = readAt - start;
  if (elapsed <= 0) return null;

  const points = sinceLastDrop([
    ...history.filter((r) => r.at >= start && r.at < readAt && sameWindow(r.resetsAt, resetsAt) && Number.isFinite(r.percent)),
    { percent, at: readAt, resetsAt },
  ]);
  const lookback = lookbackOf(length);
  const recent = points.filter((r) => r.at >= readAt - lookback);
  const span = recent.length > 0 ? recent[recent.length - 1].at - recent[0].at : 0;

  let pace: number;
  let basis: LimitEstimate['basis'];
  if (recent.length >= PACE_MIN_READINGS && span >= lookback * PACE_MIN_SPAN_SHARE) {
    pace = slope(recent);
    basis = 'recent';
  } else {
    pace = percent / elapsed;
    basis = 'window';
  }
  if (!(pace > 0)) return { runsOutAt: null, basis };
  const runsOut = readAt + (100 - percent) / pace;
  if (runsOut >= resetsAt) return { runsOutAt: null, basis };
  if (runsOut <= now) return null;
  return { runsOutAt: new Date(Math.round(runsOut)).toISOString(), basis };
}

/** The readings in time order, from the last drop on (`PERCENT_DROP_TOLERANCE`). */
function sinceLastDrop(readings: PercentReading[]): PercentReading[] {
  const sorted = [...readings].sort((a, b) => a.at - b.at);
  let from = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].percent < sorted[i - 1].percent - PERCENT_DROP_TOLERANCE) from = i;
  }
  return sorted.slice(from);
}

/** Least-squares slope, percent per ms. */
function slope(points: PercentReading[]): number {
  const n = points.length;
  const meanT = points.reduce((s, p) => s + p.at, 0) / n;
  const meanP = points.reduce((s, p) => s + p.percent, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.at - meanT) * (p.percent - meanP);
    den += (p.at - meanT) ** 2;
  }
  return den === 0 ? 0 : num / den;
}
