/**
 * The tag list the group shares (spec 2026-10-24-group-shared-settings-design
 * § Tags, ADR group-settings-converge-by-last-change): each tag's name, hue
 * and whether it is the default, under a group-wide id, with a stamp per tag
 * and a stamped tombstone per delete. The clump's anchor on the map and the
 * tag rules stay on each device. Which sessions carry a tag stays too, except
 * that two tags found to be one move the loser's sessions to the winner.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { stampBeats, type SettingStamp, type StampedTag } from '@orbital/shared/sharedSettings';
import type { OrbitalDb } from '../db/database.js';
import { sessionTags, tagRules, tagTombstones, tags, type Tag } from '../db/schema.js';
import { regenerateRuleTags } from './rules.js';

type Tx = Parameters<Parameters<OrbitalDb['transaction']>[0]>[0];
type Tombstone = typeof tagTombstones.$inferSelect;

/** What `SharedTagsStore.apply` did: whether the list changed, and the records this device stamped anew and must push. */
export type TagsApplied = { changed: boolean; restamped: StampedTag[] };

/**
 * Deletes a tag as `DELETE /api/tags/:id` does: never the default. True when
 * a row went. The caller runs `regenerateRuleTags`, so a local rule that
 * pointed at the tag behaves as it does after a local delete.
 */
export function deleteTag(db: Pick<OrbitalDb, 'delete'>, id: number): boolean {
  return db.delete(tags).where(and(eq(tags.id, id), eq(tags.isDefault, 0))).run().changes > 0;
}

/** The stored tags and tombstones with their stamps. `selfId` resolves the empty origin, which is this device. */
export class SharedTagsStore {
  constructor(
    private readonly db: OrbitalDb,
    private readonly selfId: () => string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every tag and every tombstone, as members read them; none before this device has an id. */
  list(): StampedTag[] {
    const self = this.selfId();
    if (self === null) return [];
    const live = this.db.select().from(tags).orderBy(tags.id).all().flatMap((t) => (t.uuid ? [this.record(t, self)] : []));
    const dead = this.db.select().from(tagTombstones).all().map((t) => this.tombstoneRecord(t, self));
    return [...live, ...dead];
  }

  /** A local create, rename, recolour or change of the default: the tag is stamped now, with this device as origin. */
  stampLocal(id: number): StampedTag | null {
    const self = this.selfId();
    this.db.update(tags).set({ stampAt: this.now(), stampOrigin: '' }).where(eq(tags.id, id)).run();
    const row = this.db.select().from(tags).where(eq(tags.id, id)).get();
    return row?.uuid && self !== null ? this.record(row, self) : null;
  }

  /** A local delete of the tag `uuid`, named `name`: a tombstone stamped now. */
  tombstone(uuid: string, name: string): StampedTag | null {
    const self = this.selfId();
    const values = { uuid, name, stampAt: this.now(), stampOrigin: '' };
    this.db.insert(tagTombstones).values(values).onConflictDoUpdate({ target: tagTombstones.uuid, set: values }).run();
    return self === null ? null : this.tombstoneRecord(values, self);
  }

  /**
   * This device's own tags still stamped -1 after a catch-up: kept from
   * before it joined, under names the group lacks (spec § Tags → Joining).
   * They are stamped now so that they reach the group and win over an old
   * tombstone of the same name there.
   */
  claimJoined(): StampedTag[] {
    const self = this.selfId();
    if (self === null) return [];
    const mine = and(eq(tags.stampAt, -1), eq(tags.stampOrigin, ''));
    const rows = this.db.select().from(tags).where(mine).all();
    if (rows.length === 0) return [];
    const at = this.now();
    this.db.update(tags).set({ stampAt: at }).where(mine).run();
    return rows.flatMap((t) => (t.uuid ? [this.record({ ...t, stampAt: at }, self)] : []));
  }

  /**
   * Takes every incoming record that beats what this device holds of the
   * same tag (spec § Tags). The same tag is the one of the same group id,
   * else of the same name, else, for a default, this device's default: the
   * group has one default tag. A winner that lands on a name another tag
   * holds merges the two into the one whose stamp wins. A tombstone deletes
   * as a local delete does, except the default, which is stamped anew and
   * pushed back instead. Pure in its outcome: whichever order members compare
   * the same records in, they keep the same ones.
   */
  apply(incoming: StampedTag[], primary: string | null): TagsApplied {
    const self = this.selfId();
    if (self === null || incoming.length === 0) return { changed: false, restamped: [] };
    const ordered = [...incoming].sort((a, b) => (a.at !== b.at ? a.at - b.at : a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
    const run = new ApplyRun(self, primary, this.now);
    this.db.transaction((tx) => {
      for (const r of ordered) {
        if (r.deleted) run.tombstone(tx, r);
        else run.live(tx, r);
      }
    });
    if (run.regenerate) regenerateRuleTags(this.db);
    return { changed: run.changed, restamped: run.restamped.flatMap((id) => {
      const row = this.db.select().from(tags).where(eq(tags.id, id)).get();
      return row?.uuid ? [this.record(row, self)] : [];
    }) };
  }

  private record(t: Tag, self: string): StampedTag {
    return { uuid: t.uuid!, name: t.name, hue: t.hue, isDefault: t.isDefault === 1, at: t.stampAt, origin: t.stampOrigin || self };
  }

  private tombstoneRecord(t: Tombstone, self: string): StampedTag {
    return { uuid: t.uuid, name: t.name, hue: 0, isDefault: false, at: t.stampAt, origin: t.stampOrigin || self, deleted: true };
  }
}

/** One `apply`: the comparisons and writes, inside its transaction. */
class ApplyRun {
  changed = false;
  regenerate = false;
  /** Local ids of tags this device stamped anew (a default a tombstone would have deleted). */
  readonly restamped: number[] = [];

  constructor(private readonly self: string, private readonly primary: string | null, private readonly now: () => number) {}

  private beats(a: SettingStamp, b: SettingStamp): boolean {
    return stampBeats(a, b, this.primary);
  }

  private stamp(row: { stampAt: number; stampOrigin: string }): SettingStamp {
    return { at: row.stampAt, origin: row.stampOrigin || this.self };
  }

  /** This device's own id is stored as the empty origin, as a local change is. */
  private origin(r: StampedTag): string {
    return r.origin === this.self ? '' : r.origin;
  }

  private byUuid(tx: Tx, uuid: string): Tag | undefined {
    return tx.select().from(tags).where(eq(tags.uuid, uuid)).get();
  }

  private byName(tx: Tx, name: string): Tag | undefined {
    return tx.select().from(tags).where(eq(tags.name, name)).get();
  }

  private defaultTag(tx: Tx): Tag | undefined {
    return tx.select().from(tags).where(eq(tags.isDefault, 1)).get();
  }

  live(tx: Tx, r: StampedTag): void {
    const theirs: SettingStamp = { at: r.at, origin: r.origin };
    const grave = tx.select().from(tagTombstones).where(eq(tagTombstones.uuid, r.uuid)).get();
    if (grave) {
      if (!this.beats(theirs, this.stamp(grave))) return;
      tx.delete(tagTombstones).where(eq(tagTombstones.uuid, r.uuid)).run();
    }
    // A tag of this name deleted after this record was stamped: the same tag, by name, and the delete is later.
    const namedGraves = tx.select().from(tagTombstones).where(and(eq(tagTombstones.name, r.name), ne(tagTombstones.uuid, r.uuid))).all();
    if (namedGraves.some((g) => this.beats(this.stamp(g), theirs))) return;

    let target = this.byUuid(tx, r.uuid);
    if (target) {
      if (!this.beats(theirs, this.stamp(target))) return;
    } else {
      const same = this.byName(tx, r.name) ?? (r.isDefault ? this.defaultTag(tx) : undefined);
      if (same) {
        if (!this.beats(theirs, this.stamp(same))) return;
        target = same;
      }
    }
    if (target) {
      // A rename onto a name another tag holds here: the two are one tag, and the stamp that wins keeps it.
      const other = this.byName(tx, r.name);
      if (other && other.id !== target.id) {
        if (this.beats(theirs, this.stamp(other))) {
          this.merge(tx, other, target);
          if (other.isDefault === 1) target = { ...target, isDefault: 1 };
        } else {
          this.merge(tx, target, other);
          return;
        }
      }
    }
    // The default moves only to a record that claims it with a stamp that beats the current default's.
    let isDefault = target?.isDefault ?? 0;
    if (r.isDefault && isDefault === 0) {
      const current = this.defaultTag(tx);
      if (!current || this.beats(theirs, this.stamp(current))) {
        if (current) tx.update(tags).set({ isDefault: 0 }).where(eq(tags.id, current.id)).run();
        isDefault = 1;
      }
    }
    const values = { uuid: r.uuid, name: r.name, hue: r.hue, isDefault, stampAt: r.at, stampOrigin: this.origin(r) };
    if (target) tx.update(tags).set(values).where(eq(tags.id, target.id)).run();
    else tx.insert(tags).values(values).run();
    this.changed = true;
  }

  tombstone(tx: Tx, r: StampedTag): void {
    const theirs: SettingStamp = { at: r.at, origin: r.origin };
    const grave = tx.select().from(tagTombstones).where(eq(tagTombstones.uuid, r.uuid)).get();
    if (grave && !this.beats(theirs, this.stamp(grave))) return;
    const values = { uuid: r.uuid, name: r.name, stampAt: r.at, stampOrigin: this.origin(r) };
    tx.insert(tagTombstones).values(values).onConflictDoUpdate({ target: tagTombstones.uuid, set: values }).run();
    // By name only a tag that has met the group: one this device kept from before joining (-1) is its own.
    const byName = this.byName(tx, r.name);
    const live = this.byUuid(tx, r.uuid) ?? (byName && byName.stampAt !== -1 ? byName : undefined);
    if (!live || !this.beats(theirs, this.stamp(live))) return;
    if (live.isDefault === 1) {
      // The default cannot be deleted: stamped now, it goes back to the group and wins over the tombstone there.
      tx.update(tags).set({ stampAt: this.now(), stampOrigin: '' }).where(eq(tags.id, live.id)).run();
      this.restamped.push(live.id);
      return;
    }
    deleteTag(tx, live.id);
    this.changed = true;
    this.regenerate = true;
  }

  /** `loser` and `winner` are one tag: the loser's sessions and this device's rules move to the winner, and the loser goes. */
  private merge(tx: Tx, loser: Tag, winner: Tag): void {
    // A session that carries both keeps one row of each origin.
    tx.run(sql`UPDATE OR IGNORE ${sessionTags} SET ${sql.identifier('tag_id')} = ${winner.id} WHERE ${sessionTags.tagId} = ${loser.id}`);
    tx.delete(sessionTags).where(eq(sessionTags.tagId, loser.id)).run();
    tx.update(tagRules).set({ tagId: winner.id }).where(eq(tagRules.tagId, loser.id)).run();
    tx.delete(tags).where(eq(tags.id, loser.id)).run();
    if (loser.isDefault === 1) tx.update(tags).set({ isDefault: 1 }).where(eq(tags.id, winner.id)).run();
    this.changed = true;
    this.regenerate = true;
  }
}
