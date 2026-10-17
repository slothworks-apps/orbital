/**
 * Each member's last sessions and tags in SQLite, so a member that is
 * offline when this server restarts is still on the map, dimmed, as of
 * when it was last heard from (spec 2026-10-16-device-group-design § 7).
 * Kept as the member sent them, not localized: tags are mapped by name
 * again when shown.
 */
import { eq } from 'drizzle-orm';
import { memberSnapshots } from '../db/schema.js';
import type { OrbitalDb } from '../db/database.js';
import type { Session, Tag } from './service.js';

export type MemberSnapshot = { memberId: string; sessions: Session[]; tags: Tag[]; seenAt: number };

export class MemberSnapshotStore {
  constructor(private readonly db: OrbitalDb, private readonly now: () => number = Date.now) {}

  /** Every snapshot that parses; one that does not is skipped and logged. */
  load(): MemberSnapshot[] {
    const out: MemberSnapshot[] = [];
    for (const row of this.db.select().from(memberSnapshots).all()) {
      try {
        const sessions: unknown = JSON.parse(row.sessions);
        const tags: unknown = JSON.parse(row.tags);
        if (!Array.isArray(sessions) || !Array.isArray(tags)) throw new Error('not an array');
        out.push({
          memberId: row.memberId,
          sessions: sessions.filter((s): s is Session => !!s && typeof s === 'object' && typeof s.id === 'string'),
          tags: tags.filter((t): t is Tag => !!t && typeof t === 'object' && typeof t.id === 'number' && typeof t.name === 'string'),
          seenAt: row.seenAt,
        });
      } catch (err) {
        console.warn(`[federation] snapshot of ${row.memberId} skipped: ${(err as Error).message}`);
      }
    }
    return out;
  }

  save(memberId: string, sessions: Session[], tags: Tag[], seenAt: number): void {
    const values = { sessions: JSON.stringify(sessions), tags: JSON.stringify(tags), seenAt, updatedAt: this.now() };
    this.db.insert(memberSnapshots).values({ memberId, ...values })
      .onConflictDoUpdate({ target: memberSnapshots.memberId, set: values }).run();
  }

  remove(memberId: string): void {
    this.db.delete(memberSnapshots).where(eq(memberSnapshots.memberId, memberId)).run();
  }
}
