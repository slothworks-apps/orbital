/**
 * The roster in SQLite, signatures included (ADR roster-entries-are-signed).
 * `replace` writes a whole roster at once and says whether anything changed,
 * so the service pushes only real changes.
 */
import { eq } from 'drizzle-orm';
import { rosterDigest, rosterKey, type RosterEntry } from '@orbital/shared/remote/roster';
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

  /** What members compare (`rosterDigest`): this device's founding entry is not in it. */
  digest(): string {
    return rosterDigest(this.list());
  }

  /** Writes the whole roster atomically; returns false when it is unchanged, founding entry included. */
  replace(entries: RosterEntry[]): boolean {
    if (rosterKey(entries) === rosterKey(this.list())) return false;
    this.db.transaction((tx) => {
      tx.delete(groupMembers).run();
      for (const e of entries) {
        tx.insert(groupMembers).values({
          ...e, endorsedBy: e.endorsedBy ?? null, endorsedEpoch: e.endorsedEpoch ?? null, endorsedSig: e.endorsedSig ?? null,
          removedBy: e.removedBy ?? null, removerEpoch: e.removerEpoch ?? null, removedAt: e.removedAt ?? null,
          removedSig: e.removedSig ?? null, removalEndorsedBy: e.removalEndorsedBy ?? null,
          removalEndorsedEpoch: e.removalEndorsedEpoch ?? null, removalEndorsedSig: e.removalEndorsedSig ?? null,
        }).run();
      }
    });
    return true;
  }
}

/**
 * Each optional part is all its columns or none: a row with only some of a
 * removal reads as live, with only some of an endorsement as not endorsed,
 * and a removal's endorsement goes with its removal.
 */
function fromRow(row: typeof groupMembers.$inferSelect): RosterEntry {
  const {
    endorsedBy, endorsedEpoch, endorsedSig, removedBy, removerEpoch, removedAt, removedSig, removalEndorsedBy,
    removalEndorsedEpoch, removalEndorsedSig, ...rest
  } = row;
  let entry: RosterEntry = rest;
  if (endorsedBy !== null && endorsedEpoch !== null && endorsedSig !== null) entry = { ...entry, endorsedBy, endorsedEpoch, endorsedSig };
  if (removedBy !== null && removerEpoch !== null && removedAt !== null && removedSig !== null) {
    entry = { ...entry, removedBy, removerEpoch, removedAt, removedSig };
    if (removalEndorsedBy !== null && removalEndorsedEpoch !== null && removalEndorsedSig !== null) {
      entry = { ...entry, removalEndorsedBy, removalEndorsedEpoch, removalEndorsedSig };
    }
  }
  return entry;
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
