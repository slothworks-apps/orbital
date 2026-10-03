import { describe, it, expect } from 'vitest';
import { sessions, sessionTags, tags } from '../src/db/schema.js';
import {
  countSweepable,
  parseRetentionDays,
  RETENTION_NEVER,
  retentionCutoff,
  sweepSessions,
} from '../src/retention.js';
import { openTmpDb } from './tmp.js';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

describe('parseRetentionDays', () => {
  it('reads the presets as day counts', () => {
    expect(parseRetentionDays('30')).toBe(30);
    expect(parseRetentionDays('90')).toBe(90);
    expect(parseRetentionDays('365')).toBe(365);
  });

  // The off switch has to be reachable and has to stick: this is the only
  // destructive setting in the dialog.
  it('disarms on the "never" sentinel', () => {
    expect(parseRetentionDays(RETENTION_NEVER)).toBeNull();
  });

  /**
   * Everything unreadable disarms rather than falling back to a default. For
   * a setting that deletes, "I could not parse this" must never mean "assume
   * 30 days" — a hand-edited or half-migrated row would then start deleting.
   */
  it('disarms on anything that is not a positive integer', () => {
    for (const raw of ['', '   ', '0', '-30', '30.5', '1e3', 'thirty', 'null', undefined, null]) {
      expect(parseRetentionDays(raw)).toBeNull();
    }
  });
});

describe('retentionCutoff', () => {
  it('is null while the setting is off, so nothing downstream can run', () => {
    expect(retentionCutoff(null, NOW)).toBeNull();
  });

  it('counts back whole days from now', () => {
    expect(retentionCutoff(30, NOW)).toBe(NOW - 30 * DAY);
  });
});

function makeDb() {
  const db = openTmpDb('retention');
  db.insert(tags).values({ id: 10, name: 'work', hue: 210 }).run();
  db.insert(sessions)
    .values([
      // Old enough, nothing protecting it.
      { id: 'old', projectDir: 'p', lastAt: NOW - 100 * DAY },
      // Old, but the user pinned it.
      { id: 'pinned', projectDir: 'p', lastAt: NOW - 100 * DAY, pinnedAt: NOW - 50 * DAY },
      // Old, but this server still owns it.
      { id: 'owned', projectDir: 'p', lastAt: NOW - 100 * DAY, runnerStatus: 'working' },
      // Old, but never dated — there is nothing to compare.
      { id: 'undated', projectDir: 'p', lastAt: null },
      // Inside the window.
      { id: 'recent', projectDir: 'p', lastAt: NOW - 2 * DAY },
      // Exactly on the cutoff: kept, because the predicate is strict.
      { id: 'boundary', projectDir: 'p', lastAt: NOW - 30 * DAY },
    ])
    .run();
  db.insert(sessionTags)
    .values([
      { sessionId: 'old', tagId: 10, origin: 'manual' },
      { sessionId: 'recent', tagId: 10, origin: 'manual' },
    ])
    .run();
  return db;
}

describe('sweeping', () => {
  const cutoff = retentionCutoff(30, NOW);

  it('counts exactly what it would delete', () => {
    const db = makeDb();
    expect(countSweepable(db, cutoff)).toBe(1);
    expect(sweepSessions(db, cutoff, NOW)).toEqual(['old']);
    // And the count is honest afterwards: nothing left to take.
    expect(countSweepable(db, cutoff)).toBe(0);
  });

  it('deletes nothing at all while the setting is off', () => {
    const db = makeDb();
    expect(countSweepable(db, null)).toBe(0);
    expect(sweepSessions(db, null, NOW)).toEqual([]);
    expect(db.select().from(sessions).all()).toHaveLength(6);
  });

  it('spares pinned, runner-owned, undated, recent and boundary sessions', () => {
    const db = makeDb();
    sweepSessions(db, cutoff, NOW);
    const left = db
      .select({ id: sessions.id })
      .from(sessions)
      .all()
      .map((r) => r.id)
      .sort();
    expect(left).toEqual(['boundary', 'owned', 'pinned', 'recent', 'undated']);
  });

  /**
   * `session_tags` has no foreign key, so a delete that forgot it would leave
   * rows `effectiveTagIds` keeps resolving for sessions that no longer exist.
   */
  it('takes the session tags with it, and only those', () => {
    const db = makeDb();
    sweepSessions(db, cutoff, NOW);
    const left = db
      .select({ sessionId: sessionTags.sessionId })
      .from(sessionTags)
      .all()
      .map((r) => r.sessionId);
    expect(left).toEqual(['recent']);
  });
});
