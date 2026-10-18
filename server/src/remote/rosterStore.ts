/**
 * The roster in SQLite, signatures included (ADR
 * the-group-has-one-primary-device): the primary's document across
 * `group_roster` and `group_members`, the descriptions and the left notices.
 * `replace` writes a whole state at once and says whether anything changed,
 * so the service pushes only real changes.
 */
import { eq } from 'drizzle-orm';
import { EMPTY_ROSTER, normalize, rosterDigest, rosterKey, type RosterState } from '@orbital/shared/remote/roster';
import { groupDescriptions, groupLeft, groupMembers, groupRoster, pendingRevokes } from '../db/schema.js';
import type { OrbitalDb } from '../db/database.js';

const byId = <T extends { id: string }>(x: T, y: T) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

export class RosterStore {
  constructor(private readonly db: OrbitalDb) {}

  /** What this device holds; nothing while it is alone. */
  read(): RosterState {
    const head = this.db.select().from(groupRoster).all()[0];
    if (!head) return EMPTY_ROSTER;
    const members = this.db.select().from(groupMembers).all().sort(byId);
    const roster = {
      group: head.groupId, version: head.version, members, ...(head.dissolved ? { dissolved: true as const } : {}), sig: head.sig,
    };
    const descriptions = this.db.select().from(groupDescriptions).all().sort(byId)
      .map(({ describedBy, ...d }) => ({ ...d, by: describedBy }));
    const left = this.db.select().from(groupLeft).all().sort(byId).map(({ groupId, ...n }) => ({ ...n, group: groupId }));
    return { roster, descriptions, left };
  }

  /** What members compare (`rosterDigest`). */
  digest(): string {
    return rosterDigest(this.read());
  }

  /** Writes the whole state atomically; returns false when it is unchanged. */
  replace(next: RosterState): boolean {
    const state = normalize(next);
    if (rosterKey(state) === rosterKey(this.read())) return false;
    this.db.transaction((tx) => {
      tx.delete(groupRoster).run();
      tx.delete(groupMembers).run();
      tx.delete(groupDescriptions).run();
      tx.delete(groupLeft).run();
      const doc = state.roster;
      if (!doc) return;
      tx.insert(groupRoster).values({ groupId: doc.group, version: doc.version, dissolved: doc.dissolved === true, sig: doc.sig }).run();
      for (const m of doc.members) tx.insert(groupMembers).values(m).run();
      for (const { by, ...d } of state.descriptions) tx.insert(groupDescriptions).values({ ...d, describedBy: by }).run();
      for (const { group, ...n } of state.left) tx.insert(groupLeft).values({ ...n, groupId: group }).run();
    });
    return true;
  }
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
