import { eq, sql } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { contextReports } from '../db/schema.js';
import { messageFromLocalCommandEntry } from '../transcript/notices.js';
import type { ContextReport } from '../types.js';

/**
 * The latest `/context` report Orbital keeps per session (spec
 * 2026-11-19-context-report-dialog-design § Opening it from the context
 * read-out), in `context_reports`: a typed `/context`'s twin the indexer
 * found in the transcript, or one taken on demand from the read-out. A newer
 * one replaces the row; nothing older is kept.
 */
export interface KeptReport {
  report: ContextReport;
  /** Epoch ms. */
  takenAt: number;
}

/**
 * Keeps `kept` as the session's latest report unless a newer one is already
 * kept. True when it was written — the session's `contextReportAt` moved.
 */
export function keepContextReport(db: OrbitalDb, sessionId: string, kept: KeptReport): boolean {
  const result = db
    .insert(contextReports)
    .values({ sessionId, takenAt: kept.takenAt, report: JSON.stringify(kept.report) })
    .onConflictDoUpdate({
      target: contextReports.sessionId,
      set: { takenAt: kept.takenAt, report: JSON.stringify(kept.report) },
      setWhere: sql`${contextReports.takenAt} < ${kept.takenAt}`,
    })
    .run();
  return result.changes > 0;
}

/** The session's kept report, or null — also when the stored JSON cannot be read. */
export function keptContextReport(db: OrbitalDb, sessionId: string): KeptReport | null {
  const row = db.select().from(contextReports).where(eq(contextReports.sessionId, sessionId)).get();
  if (!row) return null;
  try {
    const report = JSON.parse(row.report) as ContextReport;
    if (!report || typeof report !== 'object' || !Array.isArray(report.categories)) return null;
    return { report, takenAt: row.takenAt };
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
 * stdout only), with its entry's time. Null when there is none, or when that
 * answer carries no time to order it by.
 */
export function latestContextTwin(entries: readonly unknown[]): KeptReport | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: unknown; subtype?: unknown; timestamp?: unknown } | null;
    if (!entry || entry.type !== 'system' || entry.subtype !== 'local_command') continue;
    const message = messageFromLocalCommandEntry(entry as Parameters<typeof messageFromLocalCommandEntry>[0], '');
    const report = message?.notice?.contextReport;
    if (!report) continue;
    const takenAt = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    return Number.isFinite(takenAt) ? { report, takenAt } : null;
  }
  return null;
}
