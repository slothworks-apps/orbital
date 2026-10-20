import { describe, expect, it } from 'vitest';
import {
  ESTIMATE_MAX_AGE_MS,
  FIVE_HOUR_PACE_LOOKBACK_MS,
  FIVE_HOUR_WINDOW_MS,
  WEEKLY_WINDOW_MS,
  estimateRunOut,
  windowLengthOf,
  type EstimateInput,
  type PercentReading,
} from '../src/limits/estimate.js';

const H = 3_600_000;
const T0 = Date.parse('2026-10-20T08:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A 5-hour window that started at `T0`, read at `T0 + readH` hours. */
function fiveHour(percent: number, readH: number, over: Partial<EstimateInput> = {}): EstimateInput {
  const readAt = T0 + readH * H;
  return { kind: 'session', percent, resetsAt: T0 + FIVE_HOUR_WINDOW_MS, readAt, stale: false, now: readAt, ...over };
}

describe('windowLengthOf', () => {
  it('knows the 5-hour and the weekly kinds, from limits[] and from the fixed windows', () => {
    expect(windowLengthOf('session')).toBe(FIVE_HOUR_WINDOW_MS);
    expect(windowLengthOf('five_hour')).toBe(FIVE_HOUR_WINDOW_MS);
    for (const k of ['weekly_all', 'weekly_scoped', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
      expect(windowLengthOf(k)).toBe(WEEKLY_WINDOW_MS);
    }
    expect(windowLengthOf('monthly_burst')).toBeNull();
  });
});

describe('estimateRunOut', () => {
  it('without readings, paces at the window average from its start (reset minus its length)', () => {
    // 50 % in 2 h: 25 %/h, so the rest takes 2 h more.
    expect(estimateRunOut(fiveHour(50, 2), [])).toEqual({ runsOutAt: iso(T0 + 4 * H), basis: 'window' });
    // 20 % in 2 h: the window resets before it runs out.
    expect(estimateRunOut(fiveHour(20, 2), [])).toEqual({ runsOutAt: null, basis: 'window' });
    // Nothing spent: no pace, it lasts.
    expect(estimateRunOut(fiveHour(0, 1), [])).toEqual({ runsOutAt: null, basis: 'window' });
  });

  it('paces at the slope over the recent readings once there are enough', () => {
    // A slow start (10 % in the first 2 h), then 20 %/h over the last hour.
    const history: PercentReading[] = [
      { percent: 10, at: T0 + 2 * H, resetsAt: T0 + FIVE_HOUR_WINDOW_MS },
      { percent: 15, at: T0 + 2.25 * H, resetsAt: T0 + FIVE_HOUR_WINDOW_MS },
      { percent: 20, at: T0 + 2.5 * H, resetsAt: T0 + FIVE_HOUR_WINDOW_MS },
      { percent: 25, at: T0 + 2.75 * H, resetsAt: T0 + FIVE_HOUR_WINDOW_MS },
    ];
    // 30 % at 3 h averages 10 %/h (lasts); the last hour's 20 %/h runs out at 6.5 h… past the reset too.
    expect(estimateRunOut(fiveHour(30, 3), history)).toEqual({ runsOutAt: null, basis: 'recent' });
    // Steeper: 60 % at 3 h after 20, 30, 40, 50 — 40 %/h, the rest in 1 h.
    const steep = history.map((r, i) => ({ ...r, percent: 20 + 10 * i }));
    expect(estimateRunOut(fiveHour(60, 3), steep)).toEqual({ runsOutAt: iso(T0 + 4 * H), basis: 'recent' });
  });

  it('falls back to the average with too few readings, or readings bunched in too short a span', () => {
    const reset = T0 + FIVE_HOUR_WINDOW_MS;
    const few = [{ percent: 45, at: T0 + 1.9 * H, resetsAt: reset }];
    expect(estimateRunOut(fiveHour(50, 2), few)?.basis).toBe('window');
    const minute = 60_000;
    const bunched = [1, 2, 3].map((m) => ({ percent: 49, at: T0 + 2 * H - m * minute, resetsAt: reset }));
    expect(estimateRunOut(fiveHour(50, 2), bunched)?.basis).toBe('window');
    // Readings older than the lookback do not count toward a slope.
    const old = [1.75, 1.5, 1.25].map((k) => ({ percent: 10, at: T0 + 2 * H - k * FIVE_HOUR_PACE_LOOKBACK_MS, resetsAt: reset }));
    expect(old.every((r) => r.at >= T0)).toBe(true);
    expect(estimateRunOut(fiveHour(50, 2), old)?.basis).toBe('window');
  });

  it('ignores readings of the window before a reset, and those before the percent dropped', () => {
    const reset = T0 + FIVE_HOUR_WINDOW_MS;
    // The previous window: same shape of readings, an earlier reset.
    const previous = [1.25, 1.5, 1.75].map((h) => ({ percent: 90, at: T0 + h * H, resetsAt: reset - FIVE_HOUR_WINDOW_MS }));
    expect(estimateRunOut(fiveHour(50, 2), previous)).toEqual({ runsOutAt: iso(T0 + 4 * H), basis: 'window' });
    // A drop from 80 to 30: only what came after it counts.
    const dropped = [
      { percent: 70, at: T0 + 1 * H, resetsAt: reset },
      { percent: 80, at: T0 + 1.25 * H, resetsAt: reset },
      { percent: 30, at: T0 + 1.5 * H, resetsAt: reset },
      { percent: 40, at: T0 + 1.75 * H, resetsAt: reset },
    ];
    // 30 → 40 → 50 over half an hour: 40 %/h, the rest in 1.25 h.
    expect(estimateRunOut(fiveHour(50, 2), dropped)).toEqual({ runsOutAt: iso(T0 + 3.25 * H), basis: 'recent' });
  });

  it('starts a weekly window where the answer says it started', () => {
    const reset = T0 + WEEKLY_WINDOW_MS;
    const readAt = T0 + 24 * H;
    const weekly: EstimateInput = { kind: 'weekly_all', percent: 30, resetsAt: reset, readAt, stale: false, now: readAt };
    // From the nominal start: 30 % a day, the rest in 70/30 days.
    expect(estimateRunOut(weekly, [])?.runsOutAt).toBe(iso(readAt + (70 / 30) * 24 * H));
    // Started 12 h late: 60 % a day.
    expect(estimateRunOut({ ...weekly, startedAt: T0 + 12 * H }, [])?.runsOutAt).toBe(iso(readAt + (70 / 60) * 24 * H));
    // A start that cannot be (after the reading, or long before the week): the nominal one.
    expect(estimateRunOut({ ...weekly, startedAt: readAt + H }, [])).toEqual(estimateRunOut(weekly, []));
    expect(estimateRunOut({ ...weekly, startedAt: T0 - 3 * 24 * H }, [])).toEqual(estimateRunOut(weekly, []));
  });

  it('at the limit, says when the first reading found it there, once one below came before', () => {
    const reset = T0 + FIVE_HOUR_WINDOW_MS;
    const history = [
      { percent: 96, at: T0 + 1.5 * H, resetsAt: reset },
      { percent: 100, at: T0 + 1.75 * H, resetsAt: reset },
    ];
    expect(estimateRunOut(fiveHour(100, 2), history)).toEqual({ runsOutAt: null, basis: 'recent', ranOutAt: iso(T0 + 1.75 * H) });
    // Found at the limit by the first reading: since when is not known.
    expect(estimateRunOut(fiveHour(100, 2), [])).toBeNull();
    expect(estimateRunOut(fiveHour(100, 2), [history[1]])).toBeNull();
  });

  it('gives none for an unknown window, a stale or old reading, or without a reset', () => {
    expect(estimateRunOut(fiveHour(50, 2, { kind: 'monthly_burst' }), [])).toBeNull();
    expect(estimateRunOut(fiveHour(50, 2, { stale: true }), [])).toBeNull();
    expect(estimateRunOut(fiveHour(50, 2, { resetsAt: null }), [])).toBeNull();
    const readAt = T0 + 2 * H;
    expect(estimateRunOut(fiveHour(50, 2, { now: readAt + ESTIMATE_MAX_AGE_MS + 1 }), [])).toBeNull();
    // Read after the reset: that window is over.
    expect(estimateRunOut(fiveHour(50, 6), [])).toBeNull();
  });

  it('gives none for a run-out already past by now', () => {
    // 90 % in 1 h: the rest takes 400 s at that pace; 20 min later it is past.
    const readAt = T0 + 1 * H;
    expect(estimateRunOut(fiveHour(90, 1, { now: readAt + 20 * 60_000 }), [])).toBeNull();
  });
});
