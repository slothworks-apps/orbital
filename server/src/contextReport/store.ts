import { and, eq, gt, sql } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { contextReports, rewinds } from '../db/schema.js';
import { messageFromLocalCommandEntry } from '../transcript/notices.js';
import type { ContextReport } from '../types.js';

/**
 * The latest `/context` report Orbital keeps per session (spec
 * 2026-11-19-context-report-dialog-design § Opening it from the context
 * read-out), in `context_reports`: a typed `/context`'s twin the indexer
 * found in the transcript, or one taken on demand from the read-out. A newer
 * one replaces the row; nothing older is kept — except when the branch it
 * came from is rewound away (`followLiveBranch`).
 */
export interface KeptReport {
  report: ContextReport;
  /** Epoch ms. */
  takenAt: number;
  /**
   * Where it came from: a typed `/context` on the transcript, by its entry's
   * uuid, or the read-out, which asked the live query and wrote nothing.
   */
  origin: KeptOrigin;
}

export type KeptOrigin = { kind: 'transcript'; uuid: string } | { kind: 'readout' };

const originColumns = (origin: KeptOrigin) => ({
  origin: origin.kind,
  entryUuid: origin.kind === 'transcript' ? origin.uuid : null,
});

/** Writes `kept` as the session's row, whatever is there. */
function replaceKept(db: OrbitalDb, sessionId: string, kept: KeptReport): void {
  const set = { takenAt: kept.takenAt, report: JSON.stringify(kept.report), ...originColumns(kept.origin) };
  db.insert(contextReports).values({ sessionId, ...set })
    .onConflictDoUpdate({ target: contextReports.sessionId, set }).run();
}

/**
 * Keeps `kept` as the session's latest report unless a newer one is already
 * kept. True when it was written — the session's `contextReportAt` moved.
 * The caller makes sure the session's row exists: the retention sweep
 * deletes this row only with its session, so one written for a session
 * already gone would never be deleted.
 */
export function keepContextReport(db: OrbitalDb, sessionId: string, kept: KeptReport): boolean {
  const set = { takenAt: kept.takenAt, report: JSON.stringify(kept.report), ...originColumns(kept.origin) };
  const result = db
    .insert(contextReports)
    .values({ sessionId, ...set })
    .onConflictDoUpdate({
      target: contextReports.sessionId,
      set,
      setWhere: sql`${contextReports.takenAt} < ${kept.takenAt}`,
    })
    .run();
  return result.changes > 0;
}

/**
 * The indexer's keep, for a transcript it has just re-read: `twin` is the
 * live branch's newest `/context` (`latestContextTwin`), or null. True when
 * the row changed, so the session is republished.
 *
 * - A kept report from the transcript follows the live branch: it becomes
 *   `twin` even when that is older, and goes when the branch holds none — a
 *   rewind took its `/context` away.
 * - A kept report from the read-out stays until a newer `twin` replaces it,
 *   unless a rewind was sent from Orbital since it was taken (`rewinds`):
 *   the context it counted is gone, so `twin` stands in, or nothing. A
 *   rewind done in the terminal leaves no row there and keeps it; the next
 *   report from the read-out or a typed `/context` replaces it.
 */
export function followLiveBranch(db: OrbitalDb, sessionId: string, twin: KeptReport | null): boolean {
  const row = db.select({ takenAt: contextReports.takenAt, origin: contextReports.origin, entryUuid: contextReports.entryUuid })
    .from(contextReports).where(eq(contextReports.sessionId, sessionId)).get();
  if (!row) {
    if (twin) replaceKept(db, sessionId, twin);
    return twin !== null;
  }
  const stale = row.origin === 'transcript'
    ? !twin || twin.origin.kind !== 'transcript' || twin.origin.uuid !== row.entryUuid
    : db.select({ id: rewinds.id }).from(rewinds)
      .where(and(eq(rewinds.sessionId, sessionId), gt(rewinds.at, row.takenAt))).get() !== undefined;
  if (stale) {
    if (twin) replaceKept(db, sessionId, twin);
    else db.delete(contextReports).where(eq(contextReports.sessionId, sessionId)).run();
    return true;
  }
  return twin !== null && keepContextReport(db, sessionId, twin);
}

/** The session's kept report, or null — also when the stored JSON cannot be read. */
export function keptContextReport(db: OrbitalDb, sessionId: string): KeptReport | null {
  const row = db.select().from(contextReports).where(eq(contextReports.sessionId, sessionId)).get();
  if (!row) return null;
  try {
    const report = JSON.parse(row.report) as ContextReport;
    if (!report || typeof report !== 'object' || !Array.isArray(report.categories)) return null;
    const origin: KeptOrigin = row.origin === 'transcript' && row.entryUuid
      ? { kind: 'transcript', uuid: row.entryUuid }
      : { kind: 'readout' };
    return { report, takenAt: row.takenAt, origin };
  } catch {
    return null;
  }
}

/** When the session's kept report was taken (epoch ms), or null when none is kept. */
export function contextReportAt(db: OrbitalDb, sessionId: string): number | null {
  return db.select({ takenAt: contextReports.takenAt }).from(contextReports)
    .where(eq(contextReports.sessionId, sessionId)).get()?.takenAt ?? null;
}

/**
 * The newest `/context` answer in a transcript that carries the report as
 * data, read the way the transcript view reads it (`messageFromLocalCommandEntry`,
 * stdout only), with its entry's time and uuid. Null when there is none, or
 * when that answer carries no time to order it by or no uuid to follow it by.
 */
export function latestContextTwin(entries: readonly unknown[]): KeptReport | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: unknown; subtype?: unknown; timestamp?: unknown; uuid?: unknown } | null;
    if (!entry || entry.type !== 'system' || entry.subtype !== 'local_command') continue;
    const message = messageFromLocalCommandEntry(entry as Parameters<typeof messageFromLocalCommandEntry>[0], '');
    const report = message?.notice?.contextReport;
    if (!report) continue;
    const takenAt = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(takenAt) || typeof entry.uuid !== 'string' || entry.uuid === '') return null;
    return { report, takenAt, origin: { kind: 'transcript', uuid: entry.uuid } };
  }
  return null;
}
