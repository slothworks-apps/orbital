/**
 * The roster in SQLite, signatures included (ADR
 * the-group-has-one-primary-device): the primary's document across
 * `group_roster` and `group_members`, the descriptions and the left notices.
 * `replace` writes a whole state at once and says whether anything changed,
 * so the service pushes only real changes.
 */
import { eq } from 'drizzle-orm';
import { EMPTY_ROSTER, RosterStateSchema, normalize, rosterDigest, rosterKey, type Membership, type RosterState } from '@orbital/shared/remote/roster';
import type { GroupExit } from '@orbital/shared/remote/group';
import { groupDescriptions, groupExits, groupLeft, groupMembers, groupMembership, groupRoster, pendingRevokes } from '../db/schema.js';
import type { OrbitalDb } from '../db/database.js';
import { resetSharedStamps } from '../settings/sharedSettings.js';

const byId = <T extends { id: string }>(x: T, y: T) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

export class RosterStore {
  constructor(private readonly db: OrbitalDb) {}

  /** What this device holds; nothing while it is alone. */
  read(): RosterState {
    const head = this.db.select().from(groupRoster).all()[0];
    if (!head) return EMPTY_ROSTER;
    const members = this.db.select().from(groupMembers).all().sort(byId);
    const roster = {
      group: head.groupId, founding: head.founding, version: head.version, members, ...(head.dissolved ? { dissolved: true as const } : {}), sig: head.sig,
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
      tx.insert(groupRoster).values({
        groupId: doc.group, founding: doc.founding, version: doc.version, dissolved: doc.dissolved === true, sig: doc.sig,
      }).run();
      for (const m of doc.members) tx.insert(groupMembers).values(m).run();
      for (const { by, ...d } of state.descriptions) tx.insert(groupDescriptions).values({ ...d, describedBy: by }).run();
      for (const { group, ...n } of state.left) tx.insert(groupLeft).values({ ...n, groupId: group }).run();
    });
    return true;
  }
}

/**
 * Whether writing `next` over `prev` is this device joining a group: a
 * member of one it did not found (`self` is not its primary), of a founding
 * it was not a member of. A join made by a ceremony waits with no founding
 * until the primary's first roster; taking that roster is the join.
 */
export function joinsGroup(prev: Membership | null, next: Membership | null, self: string | null): boolean {
  if (next === null || !next.member || next.founding === null || self === null || next.group === self) return false;
  return !(prev !== null && prev.member && prev.group === next.group && prev.founding === next.founding);
}

/**
 * The group this device belongs to or is joining (`GroupStorage.membership`),
 * apart from the document. Joining a group resets the shared settings'
 * stamps in the same transaction (spec 2026-10-24-group-shared-settings-design
 * § Joining), so the group's values replace this device's own.
 */
export class GroupMembershipStore {
  constructor(private readonly db: OrbitalDb, private readonly selfId: () => string | null = () => null) {}

  get(): Membership | null {
    return this.read(this.db);
  }

  private read(db: Pick<OrbitalDb, 'select'>): Membership | null {
    const row = db.select().from(groupMembership).all()[0];
    if (!row) return null;
    const m: Membership = { group: row.groupId, founding: row.founding, version: row.version, member: row.member };
    if (row.leftFounding !== null && row.leftVersion !== null) m.left = { founding: row.leftFounding, version: row.leftVersion };
    if (row.joinExpires !== null) m.expires = row.joinExpires;
    if ((row.endedWhy === 'dissolved' || row.endedWhy === 'removed') && row.endedBy !== null && row.endedByName !== null) {
      m.ended = { why: row.endedWhy, by: { id: row.endedBy, name: row.endedByName } };
    }
    return m;
  }

  set(m: Membership | null): void {
    this.db.transaction((tx) => {
      if (joinsGroup(this.read(tx), m, this.selfId())) resetSharedStamps(tx);
      tx.delete(groupMembership).run();
      if (m === null) return;
      tx.insert(groupMembership).values({
        groupId: m.group, founding: m.founding, version: m.version, member: m.member,
        leftFounding: m.left?.founding ?? null, leftVersion: m.left?.version ?? null,
        endedWhy: m.ended?.why ?? null, endedBy: m.ended?.by.id ?? null, endedByName: m.ended?.by.name ?? null,
        joinExpires: m.expires ?? null,
      }).run();
    });
  }
}

/** Pairs that end once the document that ends them is acknowledged (`GroupStorage.exits`). */
export class GroupExitStore {
  /** The stored ids, read once: `has` is asked on every frame. Null until a read succeeds. */
  private ids: Set<string> | null = null;

  constructor(private readonly db: OrbitalDb) {}

  /** Throws when the ids do not read, and reads them again on the next call. */
  has(id: string): boolean {
    this.ids ??= new Set(this.db.select({ id: groupExits.id }).from(groupExits).all().map((r) => r.id));
    return this.ids.has(id);
  }

  /** A row whose state does not read is still an exit (state null): its device stays served nothing. */
  list(): GroupExit[] {
    return this.db.select().from(groupExits).all().map((row) => {
      let state: GroupExit['state'] = null;
      try {
        const parsed = RosterStateSchema.safeParse(JSON.parse(row.state));
        if (parsed.success) state = parsed.data;
      } catch {
        /* unreadable: kept as an exit with nothing to send */
      }
      return { id: row.id, state, since: row.since };
    });
  }

  set(exit: GroupExit): void {
    const state = JSON.stringify(exit.state);
    // Before the write: a write that fails still leaves the device served nothing until restart.
    this.ids?.add(exit.id);
    this.db.insert(groupExits).values({ id: exit.id, state, since: exit.since })
      .onConflictDoUpdate({ target: groupExits.id, set: { state, since: exit.since } }).run();
  }

  remove(id: string): void {
    this.db.delete(groupExits).where(eq(groupExits.id, id)).run();
    this.ids?.delete(id);
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
