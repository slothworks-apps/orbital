/**
 * The settings the group shares, on this device (spec
 * 2026-10-24-group-shared-settings-design, ADR
 * group-settings-converge-by-last-change): each shared key's stamp in the
 * `settings` table, the push of a local change to every member that shares,
 * and the catch-up when a channel to one comes up. The tag list travels in
 * the same bodies (`SharedTagsStore`). Nothing received is forwarded: every
 * member hears every change from the member that made it.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { TunnelError, type Channel } from '@orbital/shared/remote/channel';
import type { HelloMessage } from '@orbital/shared/remote/messages';
import type { MemberView } from '@orbital/shared/remote/roster';
import {
  SETTINGS_STAMP_SKEW_MS, SETTINGS_SYNC_CAPABILITY, SHARED_SETTINGS_PATH, SHARED_SETTING_KEYS, isSharedSetting,
  readStampedSettings, readStampedTags, stampBeats, type StampedSetting, type StampedTag,
} from '@orbital/shared/sharedSettings';
import type { OrbitalDb } from '../db/database.js';
import { settings, tagTombstones, tags } from '../db/schema.js';
import { DEVICE_HEADER } from '../remote/inject.js';
import type { SharedTagsStore } from '../tags/sharedTags.js';

/** The refusal of `/api/settings/shared` to anyone but a member that may share (`SharedSettingsSync.partner`). */
export const NOT_A_MEMBER = 'not_a_member';

/** Any drizzle handle on the database: the database itself or a transaction on it. */
type Writer = Pick<OrbitalDb, 'update'>;

/**
 * Sets every shared stamp's time to -1: this device just joined a group,
 * and every value already in it, an untouched default included, beats its
 * own. Run in the transaction that records the membership
 * (`GroupMembershipStore`), so a restart between the two cannot skip it.
 * Every tag becomes this device's own at -1 too, and every tombstone drops
 * to -1: the group's tags win by name, and the ones it lacks are kept and
 * stamped anew at the first catch-up (`SharedTagsStore.claimJoined`).
 */
export function resetSharedStamps(db: Writer): void {
  db.update(settings).set({ stampAt: -1 }).where(inArray(settings.key, [...SHARED_SETTING_KEYS])).run();
  db.update(tags).set({ stampAt: -1, stampOrigin: '' }).run();
  db.update(tagTombstones).set({ stampAt: -1 }).run();
}

/** The stored shared values and their stamps. `selfId` resolves the empty origin, which is this device. */
export class SharedSettingsStore {
  constructor(
    private readonly db: OrbitalDb,
    private readonly selfId: () => string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every shared key this device holds a row of, with its value and stamp; none before this device has an id. */
  list(): Record<string, StampedSetting> {
    const self = this.selfId();
    const out: Record<string, StampedSetting> = {};
    if (self === null) return out;
    const rows = this.db.select().from(settings).where(inArray(settings.key, [...SHARED_SETTING_KEYS])).all();
    for (const row of rows) out[row.key] = { value: row.value, at: row.stampAt, origin: row.stampOrigin || self };
    return out;
  }

  /** A local change of these shared keys: stamped now, with this device as origin. */
  stampLocal(keys: string[]): void {
    const shared = keys.filter(isSharedSetting);
    if (shared.length === 0) return;
    this.db.update(settings).set({ stampAt: this.now(), stampOrigin: '' }).where(inArray(settings.key, shared)).run();
  }

  /**
   * Takes every incoming value whose stamp beats this device's own, stamp
   * and all, and every one this device holds no row of. Returns the keys
   * whose value changed, with their new values: a stamp taken over an equal
   * value changes nothing anyone sees.
   */
  apply(incoming: Record<string, StampedSetting>, primary: string | null): Record<string, string> {
    const self = this.selfId();
    const held = this.list();
    const changed: Record<string, string> = {};
    this.db.transaction((tx) => {
      for (const [key, theirs] of Object.entries(incoming)) {
        if (!isSharedSetting(key)) continue;
        const ours = held[key];
        if (ours && !stampBeats(theirs, ours, primary)) continue;
        // This device's own id is stored as the empty origin, as a local change is.
        const origin = theirs.origin === self ? '' : theirs.origin;
        tx.insert(settings).values({ key, value: theirs.value, stampAt: theirs.at, stampOrigin: origin })
          .onConflictDoUpdate({ target: settings.key, set: { value: theirs.value, stampAt: theirs.at, stampOrigin: origin } })
          .run();
        if (ours?.value !== theirs.value) changed[key] = theirs.value;
      }
    });
    return changed;
  }

  /** A body read off a member, its future stamps clamped to this device's clock plus `SETTINGS_STAMP_SKEW_MS`. */
  read(raw: unknown): Record<string, StampedSetting> {
    return readStampedSettings(raw, this.now() + SETTINGS_STAMP_SKEW_MS);
  }

  /** The tags of a body read off a member, clamped as `read` clamps. */
  readTags(raw: unknown): StampedTag[] {
    return readStampedTags(raw, this.now() + SETTINGS_STAMP_SKEW_MS);
  }

  /** The stamp of one key, for tests. */
  stampOf(key: string): { at: number; origin: string } | null {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? { at: row.stampAt, origin: row.stampOrigin } : null;
  }
}

export type SharedSettingsSyncOptions = {
  store: SharedSettingsStore;
  /** The tag list the group shares (spec § Tags); absent, no tags travel. */
  tags?: SharedTagsStore;
  remote: {
    onChannel(listener: (id: string, channel: Channel) => void): () => void;
    onStatus(listener: () => void): () => void;
    liveMembers(): MemberView[];
    channel(id: string): Channel | null;
    peerHello(id: string): HelloMessage | null;
    selfId(): string | null;
  };
  /** Whether this device grants `memberId` its `settings` group: without it, nothing is pushed to or read from it. */
  granted: (memberId: string) => boolean;
  /** Values taken from a member changed: what a local PATCH of them sets off, and the windows told. */
  applied: (changed: Record<string, string>) => void;
  /** Tags taken from a member changed the list: this device's windows read it again. */
  tagsApplied?: () => void;
  log?: (message: string) => void;
};

export class SharedSettingsSync {
  /** The channels caught up on; a new channel to the same member catches up again. */
  private readonly caughtUp = new WeakSet<Channel>();
  private readonly channelOffs = new Map<string, { channel: Channel; off: () => void }>();
  private offs: (() => void)[] = [];
  private running = false;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: SharedSettingsSyncOptions) {
    this.log = opts.log ?? ((message) => console.warn(`[settings] ${message}`));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.offs = [
      this.opts.remote.onChannel((id, channel) => this.attach(id, channel)),
      // The roster may name a member only after its channel came up (a join): it catches up then.
      this.opts.remote.onStatus(() => this.catchUpAll()),
    ];
    for (const member of this.opts.remote.liveMembers()) {
      const channel = this.opts.remote.channel(member.id);
      if (channel) this.attach(member.id, channel);
    }
    this.catchUpAll();
  }

  stop(): void {
    this.running = false;
    for (const off of this.offs) off();
    this.offs = [];
    for (const { off } of this.channelOffs.values()) off();
    this.channelOffs.clear();
  }

  /**
   * Whether `id` may read and push this device's shared values: a member of
   * the group as this device's roster has it, not this device, not a
   * phone, and granted `settings` here.
   */
  partner(id: string): boolean {
    if (id === this.opts.remote.selfId()) return false;
    const member = this.opts.remote.liveMembers().find((m) => m.id === id);
    return member !== undefined && member.kind !== 'phone' && this.opts.granted(id);
  }

  /** Every shared value with its stamp, the empty origin named. */
  list(): Record<string, StampedSetting> {
    return this.opts.store.list();
  }

  /** Every tag and tombstone with its stamp. */
  listTags(): StampedTag[] {
    return this.opts.tags?.list() ?? [];
  }

  /** A tag was created, renamed, recoloured or made the default here: stamped now and sent to every member that shares. */
  tagChangedLocally(id: number): void {
    const record = this.opts.tags?.stampLocal(id);
    if (record) this.pushTags([record]);
  }

  /** A tag was deleted here: its tombstone is stamped now and sent. */
  tagDeletedLocally(uuid: string, name: string): void {
    const record = this.opts.tags?.tombstone(uuid, name);
    if (record) this.pushTags([record]);
  }

  /** A local PATCH changed these keys: the shared ones are stamped now and sent to every member that shares. */
  changedLocally(keys: string[]): void {
    const shared = keys.filter(isSharedSetting);
    if (shared.length === 0) return;
    this.opts.store.stampLocal(shared);
    const all = this.opts.store.list();
    this.push({ settings: Object.fromEntries(shared.flatMap((k) => (all[k] ? [[k, all[k]]] : []))) });
  }

  /** A member pushed values: those that beat this device's own are taken, and nothing is passed on. */
  receive(raw: unknown): void {
    this.take(this.opts.store.read(raw));
    this.takeTags(this.opts.store.readTags(raw));
  }

  private primary(): string | null {
    return this.opts.remote.liveMembers().find((m) => m.primary)?.id ?? null;
  }

  private take(incoming: Record<string, StampedSetting>): void {
    const changed = this.opts.store.apply(incoming, this.primary());
    if (Object.keys(changed).length > 0) this.opts.applied(changed);
  }

  /**
   * Takes the tags that beat this device's own. A default a tombstone would
   * have deleted is stamped anew and goes back to every member: that one
   * push is the only thing a receiver ever sends on.
   */
  private takeTags(incoming: StampedTag[]): void {
    if (!this.opts.tags || incoming.length === 0) return;
    const { changed, restamped } = this.opts.tags.apply(incoming, this.primary());
    if (changed) this.opts.tagsApplied?.();
    if (restamped.length > 0) this.pushTags(restamped);
  }

  private pushTags(records: StampedTag[]): void {
    this.push({ tags: records });
  }

  /** One body to every live member that shares, over a ready channel. */
  private push(body: { settings?: Record<string, StampedSetting>; tags?: StampedTag[] }): void {
    for (const member of this.opts.remote.liveMembers()) {
      const channel = this.syncChannel(member.id);
      if (channel) void this.ask(member.id, channel, 'POST', body);
    }
  }

  private attach(id: string, channel: Channel): void {
    if (!this.running) return;
    this.channelOffs.get(id)?.off();
    const off = channel.on((event) => {
      if (event.type === 'ready' && event.ready) this.catchUp(id, channel);
      if (event.type === 'closed') {
        off();
        if (this.channelOffs.get(id)?.channel === channel) this.channelOffs.delete(id);
      }
    });
    this.channelOffs.set(id, { channel, off });
  }

  /** The channel to `id` while it is ready, `id` is a partner and its hello names `settings-sync`; else null. */
  private syncChannel(id: string): Channel | null {
    if (!this.running || !this.partner(id)) return null;
    const channel = this.opts.remote.channel(id);
    if (!channel?.ready) return null;
    const hello = channel.peer ?? this.opts.remote.peerHello(id);
    return hello?.capabilities?.includes(SETTINGS_SYNC_CAPABILITY) ? channel : null;
  }

  private catchUpAll(): void {
    if (!this.running) return;
    for (const member of this.opts.remote.liveMembers()) {
      const channel = this.opts.remote.channel(member.id);
      if (channel?.ready) this.catchUp(member.id, channel);
    }
  }

  /**
   * Once per channel: the member's shared values are read and every one
   * that beats this device's own is taken. The member's own ask covers the
   * other direction. A member that does not count this device among its
   * members yet (it has not taken the roster that adds it) is asked again at
   * the next change of the roster.
   */
  private catchUp(id: string, channel: Channel): void {
    if (this.caughtUp.has(channel) || this.syncChannel(id) !== channel) return;
    this.caughtUp.add(channel);
    void this.ask(id, channel, 'GET').then((res) => {
      if (res?.status === 403 && (res.body as { error?: unknown } | null)?.error === NOT_A_MEMBER) {
        this.caughtUp.delete(channel);
        return;
      }
      if (res?.status !== 200 || !this.running) return;
      this.take(this.opts.store.read(res.body));
      this.takeTags(this.opts.store.readTags(res.body));
      // Tags kept from before joining that the group's list did not take over go to the group now.
      const claimed = this.opts.tags?.claimJoined() ?? [];
      if (claimed.length > 0) this.pushTags(claimed);
    });
  }

  /** One request to a member; a channel that failed answers nothing, a refusal is logged. */
  private async ask(id: string, channel: Channel, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; body: unknown } | null> {
    try {
      const res = await channel.request(method, SHARED_SETTINGS_PATH, body);
      if (res.status !== 200 && !(res.status === 403 && (res.body as { error?: unknown } | null)?.error === NOT_A_MEMBER)) {
        this.log(`${id} answered ${res.status} to ${method} ${SHARED_SETTINGS_PATH}`);
      }
      return res;
    } catch (err) {
      if (!(err instanceof TunnelError)) this.log(`could not reach ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

/**
 * `GET`/`POST /api/settings/shared` (spec 2026-10-24-group-shared-settings-design
 * § Transport), the shared settings and the tag list (§ Tags) in one body: only a request that came over a channel from a member of the
 * group that is not a phone and holds the `settings` grant here
 * (`SharedSettingsSync.partner`). The app on this device keeps to
 * `PATCH /api/settings`, and the phone only reads `GET /api/settings`.
 */
export function registerSharedSettingsRoutes(
  app: FastifyInstance, sync: Pick<SharedSettingsSync, 'partner' | 'list' | 'listTags' | 'receive'>,
): void {
  const partner = (req: FastifyRequest): boolean => {
    const device = req.headers[DEVICE_HEADER];
    return typeof device === 'string' && sync.partner(device);
  };
  app.get(SHARED_SETTINGS_PATH, (req, reply) => {
    if (!partner(req)) return reply.code(403).send({ error: NOT_A_MEMBER });
    return { settings: sync.list(), tags: sync.listTags() };
  });
  app.post(SHARED_SETTINGS_PATH, (req, reply) => {
    if (!partner(req)) return reply.code(403).send({ error: NOT_A_MEMBER });
    sync.receive(req.body);
    return { ok: true };
  });
}
