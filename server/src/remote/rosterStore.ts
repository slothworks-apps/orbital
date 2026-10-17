/**
 * The roster in SQLite. `replace` writes a whole roster at once and says
 * whether anything changed, so the service pushes only real changes.
 */
import { eq } from 'drizzle-orm';
import { rosterDigest, type RosterEntry } from '@orbital/shared/remote/roster';
import { groupMembers, pendingRevokes } from '../db/schema.js';
import type { OrbitalDb } from '../db/database.js';

export class RosterStore {
  constructor(private readonly db: OrbitalDb) {}

  list(): RosterEntry[] {
    return this.db.select().from(groupMembers).orderBy(groupMembers.id).all().map(fromRow);
  }

  entry(id: string): RosterEntry | null {
    return this.list().find((e) => e.id === id) ?? null;
  }

  digest(): string {
    return rosterDigest(this.list());
  }

  /** Writes the whole roster atomically; returns false when it is unchanged. */
  replace(entries: RosterEntry[]): boolean {
    if (rosterDigest(entries) === this.digest()) return false;
    this.db.transaction((tx) => {
      tx.delete(groupMembers).run();
      for (const e of entries) {
        tx.insert(groupMembers).values({
          ...e, removedBy: e.removedBy ?? null, removedAt: e.removedAt ?? null,
        }).run();
      }
    });
    return true;
  }
}

function fromRow(row: typeof groupMembers.$inferSelect): RosterEntry {
  const { removedBy, removedAt, ...rest } = row;
  return { ...rest, ...(removedBy !== null ? { removedBy } : {}), ...(removedAt !== null ? { removedAt } : {}) };
}

/** Pairs revoked here and not yet answered by the relay; kept across restarts. */
export class PendingRevokes {
  constructor(private readonly db: OrbitalDb) {}

  list(): string[] {
    return this.db.select().from(pendingRevokes).all().map((r) => r.id);
  }

  add(id: string): void {
    this.db.insert(pendingRevokes).values({ id }).onConflictDoNothing().run();
  }

  remove(id: string): void {
    this.db.delete(pendingRevokes).where(eq(pendingRevokes.id, id)).run();
  }
}
