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
import { inArray } from 'drizzle-orm';
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

  /** A local change of these keys: the shared ones are stamped now, with this device as origin, and returned. */
  stampLocal(keys: string[]): string[] {
    const shared = keys.filter(isSharedSetting);
    if (shared.length > 0) {
      this.db.update(settings).set({ stampAt: this.now(), stampOrigin: '' }).where(inArray(settings.key, shared)).run();
    }
    return shared;
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
}

/**
 * How long a member whose catch-up failed (no answer, or an answer other
 * than its values) waits before it is asked again, doubling at each failure
 * up to `CATCH_UP_RETRY_MAX_MS`, while its channel stays ready. As the seed
 * of `FederationService` (`SEED_RETRY_MS`).
 */
export const CATCH_UP_RETRY_MS = 5_000;
export const CATCH_UP_RETRY_MAX_MS = 5 * 60_000;

export type SharedSettingsSyncOptions = {
  store: SharedSettingsStore;
  /** The tag list the group shares (spec § Tags). */
  tags: SharedTagsStore;
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
  tagsApplied: () => void;
  log?: (message: string) => void;
};

/**
 * Where the catch-up with one member stands, on one ready spell of its
 * channel. `asking`: a request is out. `done`: its values are taken.
 * `refused`: it does not count this device as a member that shares (`NOT_A_MEMBER`),
 * and is asked again only when there is reason to think that changed.
 * `failed`: asked again when `retry` fires. `owed`: a push to it failed, so
 * the next try sends it every value and tag first.
 */
type CatchUp = {
  channel: Channel;
  state: 'asking' | 'done' | 'refused' | 'failed';
  failures: number;
  retry?: ReturnType<typeof setTimeout>;
  owed: boolean;
};

/** A request to a member answered with anything but 200, or not at all. */
type Outcome = 'ok' | 'refused' | 'failed';

export class SharedSettingsSync {
  /** Per member, the catch-up on its current channel; dropped when that channel stops being ready. */
  private readonly catchUps = new Map<string, CatchUp>();
  private readonly channelOffs = new Map<string, { channel: Channel; off: () => void }>();
  private offs: (() => void)[] = [];
  private running = false;
  /** The roster as last seen (`rosterKey`): a refused catch-up is asked again when it changes. */
  private roster = '';
  private readonly log: (message: string) => void;

  constructor(private readonly opts: SharedSettingsSyncOptions) {
    this.log = opts.log ?? ((message) => console.warn(`[settings] ${message}`));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.roster = this.rosterKey();
    this.offs = [
      this.opts.remote.onChannel((id, channel) => this.attach(id, channel)),
      // The roster may name a member only after its channel came up (a join): it catches up then.
      this.opts.remote.onStatus(() => this.statusChanged()),
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
    for (const id of [...this.catchUps.keys()]) this.forget(id);
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

  /**
   * `id` asked this device for its values or pushed some: it counts this
   * device as a member that shares, so a catch-up it refused is asked again.
   */
  heardFrom(id: string): void {
    const held = this.catchUps.get(id);
    if (held?.state === 'refused') this.catchUp(id, held.channel, true);
  }

  /** The grants of `id` changed here: with `settings` on, it catches up afresh, as what changed meanwhile was not sent. */
  grantsChanged(id: string): void {
    const channel = this.syncChannel(id);
    if (channel) this.catchUp(id, channel, true);
  }

  /** Every shared value with its stamp, the empty origin named. */
  list(): Record<string, StampedSetting> {
    return this.opts.store.list();
  }

  /** Every tag and tombstone with its stamp. */
  listTags(): StampedTag[] {
    return this.opts.tags.list();
  }

  /** A tag was created, renamed, recoloured or made the default here: stamped now and sent to every member that shares. */
  tagChangedLocally(id: number): void {
    const record = this.opts.tags.stampLocal(id);
    if (record) this.push({ tags: [record] });
  }

  /** A tag was deleted here: its tombstone is stamped now and sent. */
  tagDeletedLocally(uuid: string, name: string): void {
    const record = this.opts.tags.tombstone(uuid, name);
    if (record) this.push({ tags: [record] });
  }

  /** A local PATCH changed these keys: the shared ones are stamped now and sent to every member that shares. */
  changedLocally(keys: string[]): void {
    const shared = this.opts.store.stampLocal(keys);
    if (shared.length === 0) return;
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
    if (incoming.length === 0) return;
    const { changed, restamped } = this.opts.tags.apply(incoming, this.primary());
    if (changed) this.opts.tagsApplied();
    if (restamped.length > 0) this.push({ tags: restamped });
  }

  /**
   * One body to every live member that shares, over a ready channel. A
   * member that does not take it is owed everything: its catch-up is tried
   * again, with every value and tag sent first.
   */
  private push(body: { settings?: Record<string, StampedSetting>; tags?: StampedTag[] }): void {
    for (const member of this.opts.remote.liveMembers()) {
      const channel = this.syncChannel(member.id);
      if (!channel) continue;
      void this.ask(member.id, channel, 'POST', body).then(({ outcome }) => {
        if (outcome !== 'ok') this.owe(member.id, channel);
      });
    }
  }

  /** A push to `id` failed: unless a catch-up is out, it is tried again after the back-off, sending everything first. */
  private owe(id: string, channel: Channel): void {
    if (this.syncChannel(id) !== channel) return;
    this.log(`${id} did not take a change; it is sent every shared value at its next catch-up`);
    let held = this.catchUps.get(id);
    if (held?.channel !== channel) {
      held = { channel, state: 'failed', failures: 0, owed: true };
      this.catchUps.set(id, held);
    }
    held.owed = true;
    if (held.state === 'done' || (held.state === 'failed' && held.retry === undefined)) this.failed(id, held);
  }

  private attach(id: string, channel: Channel): void {
    if (!this.running) return;
    this.channelOffs.get(id)?.off();
    const off = channel.on((event) => {
      // A channel that handshakes again is a new ready spell: its catch-up starts over.
      if (event.type === 'ready' && !event.ready && this.catchUps.get(id)?.channel === channel) this.forget(id);
      if (event.type === 'ready' && event.ready) this.catchUp(id, channel);
      if (event.type === 'closed') {
        off();
        if (this.channelOffs.get(id)?.channel === channel) this.channelOffs.delete(id);
        if (this.catchUps.get(id)?.channel === channel) this.forget(id);
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

  /** Who the roster names and how: a change of it may turn a refusal into an answer. */
  private rosterKey(): string {
    return this.opts.remote.liveMembers().map((m) => `${m.id}:${m.kind}:${m.primary ? 1 : 0}`).sort().join(',');
  }

  /** A status publish: members not caught up yet catch up, and, if the roster changed, those that refused are asked again. */
  private statusChanged(): void {
    const roster = this.rosterKey();
    const rosterChanged = roster !== this.roster;
    this.roster = roster;
    if (rosterChanged) {
      for (const [id, held] of this.catchUps) if (held.state === 'refused') this.catchUp(id, held.channel, true);
    }
    this.catchUpAll();
  }

  private catchUpAll(): void {
    if (!this.running) return;
    for (const member of this.opts.remote.liveMembers()) {
      const channel = this.opts.remote.channel(member.id);
      if (channel?.ready) this.catchUp(member.id, channel);
    }
  }

  /**
   * Once per ready spell of a channel: the member's shared values are read
   * and every one that beats this device's own is taken. The member's own
   * ask covers the other direction, except for a push it did not take,
   * which is sent again here (`owed`). A failed catch-up is tried again
   * after a back-off (`CATCH_UP_RETRY_MS`); one refused because the member
   * does not count this device yet (it has not taken the roster that adds
   * it) is asked again when this device's roster changes or the member asks
   * this device (`heardFrom`). `again` asks a member that already answered.
   */
  private catchUp(id: string, channel: Channel, again = false): void {
    if (this.syncChannel(id) !== channel) return;
    let held = this.catchUps.get(id);
    if (held && held.channel !== channel) {
      this.forget(id);
      held = undefined;
    }
    if (held && (held.state === 'asking' || !again)) return;
    const entry: CatchUp = held ?? { channel, state: 'asking', failures: 0, owed: false };
    clearTimeout(entry.retry);
    entry.retry = undefined;
    entry.state = 'asking';
    this.catchUps.set(id, entry);
    void this.runCatchUp(id, entry);
  }

  private async runCatchUp(id: string, entry: CatchUp): Promise<void> {
    const current = () => this.running && this.catchUps.get(id) === entry;
    if (entry.owed) {
      const { outcome } = await this.ask(id, entry.channel, 'POST', { settings: this.list(), tags: this.listTags() });
      if (!current()) return;
      if (outcome !== 'ok') return this.settle(id, entry, outcome);
      entry.owed = false;
    }
    const { outcome, body } = await this.ask(id, entry.channel, 'GET');
    if (!current()) return;
    if (outcome !== 'ok') return this.settle(id, entry, outcome);
    try {
      this.receive(body);
      // Tags kept from before joining that the group's list did not take over go to the group now.
      const claimed = this.opts.tags.claimJoined();
      if (claimed.length > 0) this.push({ tags: claimed });
    } catch (err) {
      this.log(`could not take what ${id} holds: ${err instanceof Error ? err.message : String(err)}`);
      return this.settle(id, entry, 'failed');
    }
    this.settle(id, entry, 'ok');
  }

  /** Where a catch-up ended: done, refused until there is reason to ask again, or failed and tried again later. */
  private settle(id: string, entry: CatchUp, outcome: Outcome): void {
    if (outcome === 'ok') {
      entry.state = 'done';
      entry.failures = 0;
      // A push that failed while this catch-up was out.
      if (entry.owed) this.failed(id, entry);
    } else if (outcome === 'refused') {
      entry.state = 'refused';
    } else {
      this.failed(id, entry);
    }
  }

  /** Asked again after `CATCH_UP_RETRY_MS`, doubling at each failure in a row up to `CATCH_UP_RETRY_MAX_MS`. */
  private failed(id: string, entry: CatchUp): void {
    entry.state = 'failed';
    entry.failures += 1;
    clearTimeout(entry.retry);
    const delay = Math.min(CATCH_UP_RETRY_MS * 2 ** (entry.failures - 1), CATCH_UP_RETRY_MAX_MS);
    const timer = setTimeout(() => {
      entry.retry = undefined;
      if (this.catchUps.get(id) === entry) this.catchUp(id, entry.channel, true);
    }, delay);
    timer.unref?.();
    entry.retry = timer;
  }

  private forget(id: string): void {
    clearTimeout(this.catchUps.get(id)?.retry);
    this.catchUps.delete(id);
  }

  /** One request to a member: taken, refused as `NOT_A_MEMBER`, or failed; a failure other than a dropped tunnel is logged. */
  private async ask(id: string, channel: Channel, method: 'GET' | 'POST', body?: unknown): Promise<{ outcome: Outcome; body?: unknown }> {
    try {
      const res = await channel.request(method, SHARED_SETTINGS_PATH, body);
      if (res.status === 200) return { outcome: 'ok', body: res.body };
      if (res.status === 403 && (res.body as { error?: unknown } | null)?.error === NOT_A_MEMBER) return { outcome: 'refused' };
      this.log(`${id} answered ${res.status} to ${method} ${SHARED_SETTINGS_PATH}`);
      return { outcome: 'failed' };
    } catch (err) {
      if (!(err instanceof TunnelError)) this.log(`could not reach ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return { outcome: 'failed' };
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
  app: FastifyInstance, sync: Pick<SharedSettingsSync, 'partner' | 'heardFrom' | 'list' | 'listTags' | 'receive'>,
): void {
  const partner = (req: FastifyRequest): boolean => {
    const device = req.headers[DEVICE_HEADER];
    if (typeof device !== 'string' || !sync.partner(device)) return false;
    sync.heardFrom(device);
    return true;
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
