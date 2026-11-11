import { desc, eq } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { pendingRewinds, rewinds } from '../db/schema.js';
import type { SentRewind } from '../transcript/rewind.js';

/** A pending rewind as the `pending_rewinds` table holds it. */
export type PendingRewind = typeof pendingRewinds.$inferSelect;

/**
 * The two rewind tables (spec 2026-09-29-rewind-design § Pending rewind).
 * Stateless: every answer is read from the database, so the routes, the
 * session shape and the registry's takeover all see the same row.
 */
export class RewindStore {
  constructor(private db: OrbitalDb) {}

  pending(sessionId: string): PendingRewind | null {
    return this.db.select().from(pendingRewinds).where(eq(pendingRewinds.sessionId, sessionId)).get() ?? null;
  }

  createPending(row: PendingRewind): void {
    this.db.insert(pendingRewinds).values(row).run();
  }

  /** Deletes the pending row and returns it, or null when there was none. */
  takePending(sessionId: string): PendingRewind | null {
    const row = this.pending(sessionId);
    if (row) this.db.delete(pendingRewinds).where(eq(pendingRewinds.sessionId, sessionId)).run();
    return row;
  }

  /** The pending rewind was sent and the CLI took it: it becomes a sent one. */
  promote(sessionId: string, at = Date.now()): PendingRewind | null {
    return this.db.transaction((tx) => {
      const row = tx.select().from(pendingRewinds).where(eq(pendingRewinds.sessionId, sessionId)).get();
      if (!row) return null;
      tx.insert(rewinds)
        .values({
          sessionId, forkUuid: row.forkUuid, targetUuid: row.targetUuid,
          hiddenCount: row.hiddenCount, at,
        })
        .run();
      tx.delete(pendingRewinds).where(eq(pendingRewinds.sessionId, sessionId)).run();
      return row;
    });
  }

  sent(sessionId: string): SentRewind[] {
    return this.db
      .select({
        forkUuid: rewinds.forkUuid, targetUuid: rewinds.targetUuid,
        hiddenCount: rewinds.hiddenCount, at: rewinds.at,
      })
      .from(rewinds)
      .where(eq(rewinds.sessionId, sessionId))
      .all();
  }

  /**
   * The uuid the live branch is cut before, as `presentBranch` cuts it: a
   * pending rewind's target, or else the newest sent one's, which stays cut
   * until its new branch reaches the file and takes the target off the live
   * branch. Null without a rewind. Read without the file: the caller stops at
   * the target if it meets it.
   */
  cutTarget(sessionId: string): string | null {
    const pending = this.pending(sessionId);
    if (pending) return pending.targetUuid;
    const newest = this.db
      .select({ targetUuid: rewinds.targetUuid })
      .from(rewinds)
      .where(eq(rewinds.sessionId, sessionId))
      .orderBy(desc(rewinds.at))
      .limit(1)
      .get();
    return newest?.targetUuid ?? null;
  }
}
