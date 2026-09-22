/**
 * Settings → General → "Delete sessions older than" (spec
 * 2026-09-21-settings-sections-design § 4).
 *
 * The only destructive setting in the dialog, so the rules it obeys are worth
 * stating in one place:
 *
 * - **It is off by default and can always be turned off again.** `'never'` is
 *   not a very large number of days, it is the absence of a cutoff: nothing
 *   is computed and nothing is deleted. Any value that is not a positive
 *   integer reads the same way, so a hand-edited row cannot arm a sweep by
 *   accident.
 * - **It deletes index rows, never transcripts.** `~/.claude` is the CLI's,
 *   and Orbital only ever reads it. Which is why a swept session leaves a
 *   tombstone in `swept_sessions`: without one the indexer, which inserts
 *   every `.jsonl` the database lacks, would put it straight back on the next
 *   scan. The tombstone expires on its own the moment the transcript is
 *   written to again — see the table's comment.
 * - **A pinned session is exempt**, the same exemption the map's release
 *   timer honours ([[the-hole-subsumes-map-declutter]]): a pin is the user
 *   saying "keep this", and a clock must not overrule it.
 * - **A session the Runner still owns is exempt.** `runnerStatus` is non-null
 *   only while this server holds it, and deleting the row under a live
 *   process would leave the Runner writing to a session that no longer
 *   exists.
 * - **A session with no `lastAt` is exempt.** There is no date to compare, and
 *   guessing one would delete on a null rather than on an age.
 */

import { and, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { OrbitalDb } from './db/database.js';
import { sessions, sessionTags, sweptSessions } from './db/schema.js';

/** The "off" value, stored verbatim so the row reads as what the UI shows. */
export const RETENTION_NEVER = 'never';

/** The presets Settings → General offers, in order. */
export const RETENTION_PRESETS = ['30', '90', '365'] as const;

const MS_PER_DAY = 86_400_000;

/**
 * Days to keep, or null for "never delete anything".
 *
 * Deliberately strict: only a positive integer arms the sweep. `'never'`, an
 * empty row, a missing row, `'0'`, `'-30'`, `'30.5'` and outright garbage all
 * disarm it. For a setting that deletes, "I could not read this" has to mean
 * "do nothing", never "assume a default".
 */
export function parseRetentionDays(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === RETENTION_NEVER) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return Number.isSafeInteger(days) && days > 0 ? days : null;
}

/** Epoch ms before which a session is old enough to sweep, or null when off. */
export function retentionCutoff(days: number | null, now: number): number | null {
  return days === null ? null : now - days * MS_PER_DAY;
}



/**
 * The one predicate both the count and the delete run on — see the header.
 *
 * `lastAt IS NULL` needs no clause of its own: `NULL < cutoff` evaluates to
 * NULL in SQLite, which is not true, so an undated session never matches.
 */
function sweepable(cutoff: number) {
  return and(
    lt(sessions.lastAt, cutoff),
    isNull(sessions.pinnedAt),
    isNull(sessions.runnerStatus),
  );
}

/**
 * How many sessions a cutoff would remove. This is what the confirmation
 * names before anything is deleted, so it has to run the same predicate the
 * delete does — hence `sweepable` rather than two hand-kept copies.
 */
export function countSweepable(db: OrbitalDb, cutoff: number | null): number {
  if (cutoff === null) return 0;
  const row = db
    .select({ total: sql<number>`COUNT(*)` })
    .from(sessions)
    .where(sweepable(cutoff))
    .get();
  return row?.total ?? 0;
}

/**
 * Delete every session older than the cutoff and return their ids, so the
 * caller can publish one `remove` per row and the open maps drop them
 * without a reload.
 *
 * `session_tags` has no foreign key, so its rows are deleted explicitly —
 * leaving them would accumulate orphans that `effectiveTagIds` would keep
 * resolving for sessions that no longer exist. `errors` rows are left alone
 * on purpose: the log is a record of what happened, it prunes itself to the
 * newest 1000, and a failure is still worth reading after the session it was
 * about has been tidied away.
 */
export function sweepSessions(db: OrbitalDb, cutoff: number | null, now: number): string[] {
  if (cutoff === null) return [];
  const doomed = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(sweepable(cutoff))
    .all()
    .map((row) => row.id);
  if (doomed.length === 0) return [];

  db.transaction((tx) => {
    tx.delete(sessionTags).where(inArray(sessionTags.sessionId, doomed)).run();
    tx.delete(sessions).where(inArray(sessions.id, doomed)).run();
    // Stamped with `now`, not with the session's own `lastAt`: the question
    // the indexer asks later is "has this transcript been written to since we
    // swept it", and the sweep is what has to be dated for that to work.
    tx.insert(sweptSessions)
      .values(doomed.map((id) => ({ id, sweptAt: now })))
      .onConflictDoUpdate({ target: sweptSessions.id, set: { sweptAt: now } })
      .run();
  });
  return doomed;
}

/** The settings key, named once so the UI, the boot sweep and the PATCH hook
 * cannot drift apart on a string literal. */
export const RETENTION_KEY = 'delete_sessions_older_than_days';
