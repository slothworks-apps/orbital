import { and, asc, desc, eq, gt, lt, lte, or } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { limitReadings } from '../db/schema.js';
import { PERCENT_DROP_TOLERANCE, SAME_WINDOW_TOLERANCE_MS, WEEKLY_WINDOW_MS, type PercentReading } from './estimate.js';

/**
 * Past the longest window by this much, a reading goes whatever its window:
 * an account no longer signed in anywhere leaves nothing behind for good.
 */
export const HISTORY_MAX_AGE_MS = WEEKLY_WINDOW_MS + 86_400_000;

/**
 * The readings of each plan window, stored so the estimate survives a
 * restart (spec 2026-10-20-limit-suns-design § 2). Only the window as it
 * stands is kept: a reading of a new window (its reset moved past
 * `SAME_WINDOW_TOLERANCE_MS`) drops the old window's, and a percent below
 * the last one (past `PERCENT_DROP_TOLERANCE`) drops everything before it.
 */
export class LimitHistory {
  /** Each window's readings as last read from the table, until the next `record` of it. */
  private readonly cache = new Map<string, PercentReading[]>();

  constructor(private readonly db: OrbitalDb) {}

  /** One reading of one window. `resetsAt` and `at` are epoch ms. */
  record(readingKey: string, window: string, percent: number, resetsAt: number, at: number): void {
    const same = and(eq(limitReadings.readingKey, readingKey), eq(limitReadings.window, window));
    this.db.transaction((tx) => {
      // Another window's readings: its reset is not this one's.
      tx.delete(limitReadings).where(and(same, or(
        lt(limitReadings.resetsAt, resetsAt - SAME_WINDOW_TOLERANCE_MS),
        gt(limitReadings.resetsAt, resetsAt + SAME_WINDOW_TOLERANCE_MS),
      ))).run();
      const last = tx.select({ percent: limitReadings.percent }).from(limitReadings)
        .where(and(same, lte(limitReadings.readAt, at)))
        .orderBy(desc(limitReadings.readAt)).limit(1).get();
      if (last && percent < last.percent - PERCENT_DROP_TOLERANCE) tx.delete(limitReadings).where(same).run();
      tx.insert(limitReadings).values({ readingKey, window, percent, resetsAt, readAt: at }).run();
      tx.delete(limitReadings).where(lt(limitReadings.readAt, at - HISTORY_MAX_AGE_MS)).run();
    });
    // The age sweep may have taken any window's: every one is read again.
    this.cache.clear();
  }

  /** One window's readings, oldest first. */
  readings(readingKey: string, window: string): PercentReading[] {
    const id = `${readingKey}\n${window}`;
    let held = this.cache.get(id);
    if (!held) {
      held = this.db.select({ percent: limitReadings.percent, at: limitReadings.readAt, resetsAt: limitReadings.resetsAt })
        .from(limitReadings)
        .where(and(eq(limitReadings.readingKey, readingKey), eq(limitReadings.window, window)))
        .orderBy(asc(limitReadings.readAt))
        .all();
      this.cache.set(id, held);
    }
    return held;
  }
}
