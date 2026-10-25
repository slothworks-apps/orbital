import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Channel, ChannelEvent } from '@orbital/shared/remote/channel';
import type { HelloMessage } from '@orbital/shared/remote/messages';
import type { MemberView } from '@orbital/shared/remote/roster';
import { SETTINGS_STAMP_SKEW_MS, isPerDeviceSetting, isSharedSetting } from '@orbital/shared/sharedSettings';
import { DEFAULT_SETTINGS, openDb, type OrbitalDb } from '../src/db/database.js';
import { sessionTags, settings, tagRules, tags, tagTombstones, type Tag } from '../src/db/schema.js';
import { SharedTagsStore, TAG_TOMBSTONE_TTL_MS } from '../src/tags/sharedTags.js';
import { DEVICE_HEADER } from '../src/remote/inject.js';
import { GroupMembershipStore, joinsGroup } from '../src/remote/rosterStore.js';
import { CATCH_UP_RETRY_MS, SharedSettingsStore, SharedSettingsSync, registerSharedSettingsRoutes } from '../src/settings/sharedSettings.js';
import { migrationsBefore } from './migrations.js';
import { makeTmpDir, openTmpDb } from './tmp.js';

const PRIMARY = 'P'.repeat(43);
const LAPTOP = 'L'.repeat(43);
const BOX = 'B'.repeat(43);
const PHONE = 'F'.repeat(43);

const member = (id: string, kind = 'desktop', primary = false) =>
  ({ id, kind, name: id.slice(0, 1), os: 'macos', primary }) as unknown as MemberView;

/** A channel to a member that answers by its routes, as `ServingHalf` would inject them. */
class FakeChannel {
  ready = false;
  readonly peer: HelloMessage;
  private readonly listeners = new Set<(e: ChannelEvent) => void>();
  readonly request = vi.fn(async (method: string, path: string, body?: unknown) => {
    const res = await this.member.inject({
      method: method as 'GET', url: path, ...(body !== undefined ? { payload: body as object } : {}), headers: { [DEVICE_HEADER]: this.asker },
    });
    return { status: res.statusCode, body: res.json() };
  });

  constructor(private readonly member: FastifyInstance, private readonly asker: string, capabilities = ['sessions', 'group', 'settings-sync']) {
    this.peer = { t: 'hello', protocol: 1, kind: 'desktop', capabilities } as unknown as HelloMessage;
  }

  on(listener: (e: ChannelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  up(): void {
    this.ready = true;
    for (const l of [...this.listeners]) l({ type: 'ready', ready: true });
  }

  /** The tunnel under it is gone; `up` again is a new handshake on the same channel. */
  down(): void {
    this.ready = false;
    for (const l of [...this.listeners]) l({ type: 'ready', ready: false });
  }
}

/** One device: its database, its sync, its routes, and the roster it holds. */
function device(self: string, opts: { members?: MemberView[]; grants?: Record<string, boolean>; now?: () => number } = {}) {
  const db = openTmpDb('shared');
  const members = opts.members ?? [member(PRIMARY, 'desktop', true), member(LAPTOP), member(BOX, 'headless'), member(PHONE, 'phone')];
  const channels = new Map<string, FakeChannel>();
  const channelListeners = new Set<(id: string, c: Channel) => void>();
  const statusListeners = new Set<() => void>();
  const applied: Record<string, string>[] = [];
  const tagsApplied: number[] = [];
  const store = new SharedSettingsStore(db, () => self, opts.now);
  const tagStore = new SharedTagsStore(db, () => self, opts.now);
  const sync = new SharedSettingsSync({
    store,
    tags: tagStore,
    tagsApplied: () => tagsApplied.push(1),
    remote: {
      onChannel: (l) => { channelListeners.add(l); return () => channelListeners.delete(l); },
      onStatus: (l) => { statusListeners.add(l); return () => statusListeners.delete(l); },
      liveMembers: () => members,
      channel: (id) => (channels.get(id) as unknown as Channel) ?? null,
      peerHello: () => null,
      selfId: () => self,
    },
    granted: (id) => opts.grants?.[id] ?? true,
    applied: (changed) => applied.push(changed),
    log: () => {},
  });
  const app = Fastify();
  registerSharedSettingsRoutes(app, sync);
  sync.start();
  return {
    db, store, sync, app, applied, members, tagStore, tagsApplied,
    /** A channel to `other`, announced as the remote announces a new one. */
    link(other: { app: FastifyInstance }, id: string, capabilities?: string[]): FakeChannel {
      const channel = new FakeChannel(other.app, self, capabilities);
      channels.set(id, channel);
      for (const l of [...channelListeners]) l(id, channel as unknown as Channel);
      return channel;
    },
    statusChanged: () => { for (const l of [...statusListeners]) l(); },
    set(key: string, value: string, at = 0, origin = ''): void {
      db.insert(settings).values({ key, value, stampAt: at, stampOrigin: origin })
        .onConflictDoUpdate({ target: settings.key, set: { value, stampAt: at, stampOrigin: origin } }).run();
    },
    value: (key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value,
    /** A tag made here, as `POST /api/tags` and a stamp at `at` would leave it. */
    addTag(name: string, hue: number, at = 0, extra: Partial<typeof tags.$inferInsert> = {}): Tag {
      return db.insert(tags).values({ name, hue, stampAt: at, ...extra }).returning().get();
    },
    tag: (name: string) => db.select().from(tags).where(eq(tags.name, name)).get(),
    tagNames: () => db.select().from(tags).orderBy(tags.name).all().map((t) => t.name),
    tagged(sessionId: string): number[] {
      return db.select().from(sessionTags).where(eq(sessionTags.sessionId, sessionId)).all().map((r) => r.tagId);
    },
  };
}

/** The stamp of one key as stored. */
function stampOf(db: OrbitalDb, key: string): { at: number; origin: string } | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? { at: row.stampAt, origin: row.stampOrigin } : null;
}

/** Every request a fake channel was asked has been answered. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Every file under `dir` whose name ends in `.ts` or `.tsx`, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !/(^|\/)test\//.test(f) && !f.includes('.test.'))
    .map((f) => join(dir, f));
}

/**
 * Words that read like a setting key where the sources name settings, but
 * are not one: fields of other objects read off a `settings`-named value.
 */
const NOT_SETTINGS = new Set(['claude_code_version', 'claude_directory']);

describe('the classes of settings', () => {
  it('places every seeded setting in exactly one class', () => {
    const unclassified = Object.keys(DEFAULT_SETTINGS).filter((k) => isSharedSetting(k) === isPerDeviceSetting(k));
    expect(unclassified).toEqual([]);
  });

  it('places every setting the app reads or writes in exactly one class, seeded or not', () => {
    // How the sources name a key: `settings.get('x')`, `settings.x`, `settings['x']`, and a `…_KEY`/`…_SETTING` constant.
    const pattern = /settings(?:\.get|\.set)?\(?\s*\[?'([a-z][a-z0-9]*_[a-z0-9_]+)'|settings\.([a-z][a-z0-9]*_[a-z0-9_]+)|_(?:KEY|SETTING)\s*=\s*'([a-z][a-z0-9]*_[a-z0-9_]+)'/g;
    const root = join(import.meta.dirname, '..', '..');
    const keys = new Set<string>();
    for (const dir of ['web/src', 'server/src', 'desktop/src', 'shared/src']) {
      for (const file of sources(join(root, dir))) {
        for (const m of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(m[1] ?? m[2] ?? m[3]);
      }
    }
    // The scan finds keys at all: a pattern that matched nothing would pass anything.
    expect(keys.has('map_theme')).toBe(true);
    const unclassified = [...keys].filter((k) => !NOT_SETTINGS.has(k) && isSharedSetting(k) === isPerDeviceSetting(k));
    expect(unclassified).toEqual([]);
  });
});

describe('the stamp migration', () => {
  it('keeps every existing value, at time 0 on this device', () => {
    const dir = makeTmpDir('stamps');
    const dbPath = join(dir, 'index.db');
    const old = openDb(dbPath, migrationsBefore(dir, '_group_shared_settings'));
    old.$client.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('default_model', 'opus');
    old.$client.close();
    const db = openDb(dbPath);
    expect(db.select().from(settings).where(eq(settings.key, 'default_model')).get())
      .toEqual({ key: 'default_model', value: 'opus', stampAt: 0, stampOrigin: '' });
    db.$client.close();
  });
});

describe('/api/settings/shared', () => {
  it('answers only a member of the group that is not a phone and holds the settings grant', async () => {
    const d = device(PRIMARY, { grants: { [BOX]: false } });
    const get = (device?: string) => d.app.inject({ method: 'GET', url: '/api/settings/shared', headers: device ? { [DEVICE_HEADER]: device } : {} });
    // The app on this device, a phone, a member without the grant, a stranger, this device itself.
    for (const asker of [undefined, PHONE, BOX, 'X'.repeat(43), PRIMARY]) expect((await get(asker)).statusCode).toBe(403);
    const res = await get(LAPTOP);
    expect(res.statusCode).toBe(200);
    // Only shared keys; a seeded one at time 0, named as this device's.
    expect(res.json().settings.default_model).toEqual({ value: 'sonnet', at: 0, origin: PRIMARY });
    expect(res.json().settings.claude_executable_path).toBeUndefined();
    // A push from a phone, or from a member without the grant, changes nothing.
    for (const asker of [PHONE, BOX]) {
      const post = await d.app.inject({
        method: 'POST', url: '/api/settings/shared', payload: { settings: { default_model: { value: 'x', at: 9, origin: asker } } },
        headers: { [DEVICE_HEADER]: asker },
      });
      expect(post.statusCode).toBe(403);
    }
    expect(d.value('default_model')).toBe('sonnet');
  });

  it('clamps a stamp from the future to the receiver\'s clock plus the skew', async () => {
    const d = device(PRIMARY, { now: () => 1_000 });
    await d.app.inject({
      method: 'POST', url: '/api/settings/shared', headers: { [DEVICE_HEADER]: LAPTOP },
      payload: { settings: { default_model: { value: 'opus', at: 10 ** 15, origin: LAPTOP } } },
    });
    expect(stampOf(d.db, 'default_model')).toEqual({ at: 1_000 + SETTINGS_STAMP_SKEW_MS, origin: LAPTOP });
  });
});

describe('applying a member\'s values', () => {
  it('takes a newer value with its stamp and reports it; ignores an older one and a per-device key', () => {
    const d = device(PRIMARY);
    d.set('default_model', 'opus', 50);
    d.sync.receive({ settings: {
      default_model: { value: 'haiku', at: 40, origin: LAPTOP },
      confirm_before_clear: { value: 'false', at: 60, origin: LAPTOP },
      claude_executable_path: { value: '/elsewhere/claude', at: 60, origin: LAPTOP },
    } });
    expect(d.value('default_model')).toBe('opus');
    expect(d.value('confirm_before_clear')).toBe('false');
    expect(stampOf(d.db, 'confirm_before_clear')).toEqual({ at: 60, origin: LAPTOP });
    expect(d.value('claude_executable_path')).toBe('');
    expect(d.applied).toEqual([{ confirm_before_clear: 'false' }]);
  });

  it('takes a key it holds no row of, and a stamp over an equal value without reporting a change', () => {
    const d = device(LAPTOP);
    d.sync.receive({ settings: {
      map_theme: { value: 'desk', at: 0, origin: PRIMARY },
      default_model: { value: 'sonnet', at: 0, origin: PRIMARY },
    } });
    expect(d.value('map_theme')).toBe('desk');
    expect(stampOf(d.db, 'default_model')).toEqual({ at: 0, origin: PRIMARY });
    expect(d.applied).toEqual([{ map_theme: 'desk' }]);
  });
});

describe('a local change', () => {
  it('is stamped now and pushed to every live member that shares and is granted', async () => {
    let now = 500;
    const primary = device(PRIMARY, { now: () => now, grants: { [BOX]: false } });
    const laptop = device(LAPTOP);
    const box = device(BOX);
    const old = device('O'.repeat(43));
    const toLaptop = primary.link(laptop, LAPTOP);
    const toBox = primary.link(box, BOX);
    const toOld = primary.link(old, 'O'.repeat(43), ['sessions', 'group']);
    for (const c of [toLaptop, toBox, toOld]) c.ready = true;
    primary.set('default_model', 'opus');
    primary.set('sidebar_width', '400');
    now = 900;
    primary.sync.changedLocally(['default_model', 'sidebar_width']);
    await settle();
    expect(stampOf(primary.db, 'default_model')).toEqual({ at: 900, origin: '' });
    expect(stampOf(primary.db, 'sidebar_width')).toEqual({ at: 0, origin: '' });
    expect(toLaptop.request).toHaveBeenCalledWith('POST', '/api/settings/shared', {
      settings: { default_model: { value: 'opus', at: 900, origin: PRIMARY } },
    });
    expect(laptop.value('default_model')).toBe('opus');
    // Not granted `settings` here, and too old to share: neither is sent anything.
    expect(toBox.request).not.toHaveBeenCalled();
    expect(toOld.request).not.toHaveBeenCalled();
  });
});

describe('catching up', () => {
  it('converges two members with diverging values, whichever comes up first', async () => {
    const primary = device(PRIMARY);
    const laptop = device(LAPTOP);
    primary.set('default_model', 'opus');
    laptop.set('map_theme', 'desk', 70);
    laptop.set('confirm_before_clear', 'false', 30);
    primary.set('confirm_before_clear', 'true', 40);
    const toLaptop = primary.link(laptop, LAPTOP);
    const toPrimary = laptop.link(primary, PRIMARY);
    toPrimary.up();
    toLaptop.up();
    await settle();
    for (const d of [primary, laptop]) {
      // An untouched value on both: the primary's. A later change: wherever it was made.
      expect(d.value('default_model')).toBe('opus');
      expect(d.value('map_theme')).toBe('desk');
      expect(d.value('confirm_before_clear')).toBe('true');
    }
    expect(stampOf(laptop.db, 'default_model')).toEqual({ at: 0, origin: PRIMARY });
    expect(stampOf(primary.db, 'map_theme')).toEqual({ at: 70, origin: LAPTOP });
    // Once per channel.
    toLaptop.up();
    await settle();
    expect(toLaptop.request).toHaveBeenCalledTimes(1);
  });

  it('asks a member that refused again once it asks this device, or this device\'s roster changes; not at every status publish', async () => {
    const laptop = device(LAPTOP);
    // The primary has not taken the roster that adds the laptop yet.
    const primary = device(PRIMARY, { members: [member(PRIMARY, 'desktop', true)] });
    primary.set('default_model', 'opus', 10);
    const toPrimary = laptop.link(primary, PRIMARY);
    const toLaptop = primary.link(laptop, LAPTOP);
    toPrimary.up();
    await settle();
    expect(laptop.value('default_model')).toBe('sonnet');
    // Presence and the like publish the status: a refusal is not asked again for that.
    laptop.statusChanged();
    await settle();
    expect(toPrimary.request).toHaveBeenCalledTimes(1);
    // The primary takes the roster and catches up with the laptop: the laptop asks it again.
    primary.members.push(member(LAPTOP));
    toLaptop.up();
    await settle();
    expect(laptop.value('default_model')).toBe('opus');

    // A refusal asked again at a change of this device's own roster.
    const box = device(BOX, { members: [member(BOX, 'headless')] });
    box.set('default_model', 'haiku', 20);
    const toBox = laptop.link(box, BOX);
    toBox.up();
    await settle();
    expect(laptop.value('default_model')).toBe('opus');
    box.members.push(member(LAPTOP));
    laptop.members.push(member('Z'.repeat(43)));
    laptop.statusChanged();
    await settle();
    expect(laptop.value('default_model')).toBe('haiku');
  });

  it('catches up again when the same channel handshakes again', async () => {
    const primary = device(PRIMARY);
    const laptop = device(LAPTOP);
    const toPrimary = laptop.link(primary, PRIMARY);
    toPrimary.up();
    await settle();
    primary.set('default_model', 'opus', 10);
    toPrimary.down();
    toPrimary.up();
    await settle();
    expect(toPrimary.request).toHaveBeenCalledTimes(2);
    expect(laptop.value('default_model')).toBe('opus');
  });

  it('tries a failed catch-up again after a back-off that doubles, and one whose values could not be taken', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const primary = device(PRIMARY);
      const laptop = device(LAPTOP);
      primary.set('default_model', 'opus', 10);
      const toPrimary = laptop.link(primary, PRIMARY);
      toPrimary.request.mockResolvedValueOnce({ status: 503, body: null });
      toPrimary.request.mockRejectedValueOnce(new Error('timed out'));
      toPrimary.up();
      await settle();
      expect(toPrimary.request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CATCH_UP_RETRY_MS);
      await settle();
      expect(toPrimary.request).toHaveBeenCalledTimes(2);
      // The second failure waits twice as long.
      await vi.advanceTimersByTimeAsync(CATCH_UP_RETRY_MS);
      await settle();
      expect(toPrimary.request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(CATCH_UP_RETRY_MS);
      await settle();
      expect(toPrimary.request).toHaveBeenCalledTimes(3);
      expect(laptop.value('default_model')).toBe('opus');

      // Taking the values throws: logged, not an unhandled rejection, and tried again.
      const box = device(BOX);
      box.set('default_model', 'haiku', 20);
      const apply = vi.spyOn(laptop.store, 'apply').mockImplementationOnce(() => { throw new Error('disk full'); });
      const toBox = laptop.link(box, BOX);
      toBox.up();
      await settle();
      expect(apply).toHaveBeenCalledTimes(1);
      expect(laptop.value('default_model')).toBe('opus');
      await vi.advanceTimersByTimeAsync(CATCH_UP_RETRY_MS);
      await settle();
      expect(laptop.value('default_model')).toBe('haiku');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a member that did not take a push every value at its next try', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const primary = device(PRIMARY);
      const laptop = device(LAPTOP);
      const toLaptop = primary.link(laptop, LAPTOP);
      toLaptop.up();
      await settle();
      primary.set('default_model', 'opus');
      toLaptop.request.mockResolvedValueOnce({ status: 500, body: null });
      primary.sync.changedLocally(['default_model']);
      await settle();
      expect(laptop.value('default_model')).toBe('sonnet');
      await vi.advanceTimersByTimeAsync(CATCH_UP_RETRY_MS);
      await settle();
      expect(laptop.value('default_model')).toBe('opus');
      expect(toLaptop.request).toHaveBeenLastCalledWith('GET', '/api/settings/shared', undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('catches up afresh with a member whose settings grant is turned back on', async () => {
    const grants: Record<string, boolean> = {};
    const primary = device(PRIMARY);
    const laptop = device(LAPTOP, { grants });
    const toPrimary = laptop.link(primary, PRIMARY);
    toPrimary.up();
    await settle();
    grants[PRIMARY] = false;
    primary.set('default_model', 'opus', 10);
    grants[PRIMARY] = true;
    laptop.sync.grantsChanged(PRIMARY);
    await settle();
    expect(laptop.value('default_model')).toBe('opus');
  });
});

describe('joining a group', () => {
  it('is a membership of a group this device did not found, of a founding it was not in', () => {
    const joining = { group: PRIMARY, founding: null, version: 0, member: true, expires: 1 };
    const joined = { group: PRIMARY, founding: 'f1', version: 1, member: true };
    expect(joinsGroup(joining, joined, LAPTOP)).toBe(true);
    expect(joinsGroup(null, joined, LAPTOP)).toBe(true);
    expect(joinsGroup({ ...joined, member: false }, joined, LAPTOP)).toBe(true);
    // A later version of the same group, its founder, a pending join, leaving.
    expect(joinsGroup(joined, { ...joined, version: 2 }, LAPTOP)).toBe(false);
    expect(joinsGroup(null, { ...joined, group: LAPTOP }, LAPTOP)).toBe(false);
    expect(joinsGroup(null, joining, LAPTOP)).toBe(false);
    expect(joinsGroup(joined, { ...joined, member: false }, LAPTOP)).toBe(false);
  });

  it('resets every shared stamp in the write that records it, and leaves the per-device ones', () => {
    const db: OrbitalDb = openTmpDb('join');
    const store = new SharedSettingsStore(db, () => LAPTOP);
    const membership = new GroupMembershipStore(db, () => LAPTOP);
    db.update(settings).set({ stampAt: 80 }).run();
    membership.set({ group: PRIMARY, founding: null, version: 0, member: true, expires: 1 });
    expect(stampOf(db, 'default_model')?.at).toBe(80);
    membership.set({ group: PRIMARY, founding: 'f1', version: 1, member: true });
    expect(stampOf(db, 'default_model')?.at).toBe(-1);
    expect(stampOf(db, 'sidebar_width')?.at).toBe(80);
    // A later version of the same group resets nothing.
    store.stampLocal(['default_model']);
    membership.set({ group: PRIMARY, founding: 'f1', version: 2, member: true });
    expect(stampOf(db, 'default_model')?.at).toBeGreaterThan(0);
  });
});

describe('the tag migration', () => {
  it('gives every existing tag a group id and keeps its row, sessions and anchor; a later insert gets one too', () => {
    const dir = makeTmpDir('tag-ids');
    const dbPath = join(dir, 'index.db');
    const old = openDb(dbPath, migrationsBefore(dir, '_group_shared_tags'));
    old.$client.prepare('INSERT INTO tags (id, name, hue, anchor_x, anchor_y) VALUES (7, ?, 40, 1.5, -2)').run('work');
    old.$client.prepare('INSERT INTO session_tags (session_id, tag_id, origin) VALUES (?, 7, ?)').run('s1', 'manual');
    old.$client.close();
    const db = openDb(dbPath);
    const all = db.select().from(tags).all();
    expect(all.find((t) => t.id === 7)).toMatchObject({ name: 'work', hue: 40, anchorX: 1.5, anchorY: -2, stampAt: 0, stampOrigin: '' });
    expect(new Set(all.map((t) => t.uuid)).size).toBe(all.length);
    for (const t of all) expect(t.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(db.select().from(sessionTags).all()).toEqual([{ sessionId: 's1', tagId: 7, origin: 'manual' }]);
    // A raw insert, as the default tag's seed is, still gets an id.
    db.$client.prepare("INSERT INTO tags (name, hue) VALUES ('raw', 1)").run();
    expect(db.select().from(tags).where(eq(tags.name, 'raw')).get()?.uuid).toMatch(/^[0-9a-f-]{36}$/);
    db.$client.close();
  });
  it('seeds the default tag with a group id of its own, not the insert trigger\'s', () => {
    const dir = makeTmpDir('default-id');
    const dbPath = join(dir, 'index.db');
    const first = openDb(dbPath);
    first.$client.exec('DROP TRIGGER `tags_uuid_on_insert`; DELETE FROM `tags`;');
    first.$client.close();
    const db = openDb(dbPath);
    expect(db.select().from(tags).where(eq(tags.isDefault, 1)).get()?.uuid).toMatch(/^[0-9a-f-]{36}$/);
    db.$client.close();
  });
});

describe('the tag list the group shares', () => {
  /** Two members whose channels are up both ways, caught up. */
  async function pair(primary: ReturnType<typeof device>, laptop: ReturnType<typeof device>) {
    const toLaptop = primary.link(laptop, LAPTOP);
    const toPrimary = laptop.link(primary, PRIMARY);
    toPrimary.up();
    toLaptop.up();
    await settle();
    return { toLaptop, toPrimary };
  }

  it('lists tags and tombstones on the route, never an anchor', async () => {
    const d = device(PRIMARY);
    d.addTag('work', 10, 5, { anchorX: 3, anchorY: 4 });
    d.tagStore.tombstone('gone-id', 'gone');
    const res = await d.app.inject({ method: 'GET', url: '/api/settings/shared', headers: { [DEVICE_HEADER]: LAPTOP } });
    const listed = res.json().tags as Record<string, unknown>[];
    expect(listed.find((t) => t.name === 'work')).toEqual({ uuid: d.tag('work')!.uuid, name: 'work', hue: 10, isDefault: false, at: 5, origin: PRIMARY });
    expect(listed.find((t) => t.name === 'gone')).toMatchObject({ uuid: 'gone-id', deleted: true });
    // A push of tags from a phone changes nothing.
    await d.app.inject({
      method: 'POST', url: '/api/settings/shared', headers: { [DEVICE_HEADER]: PHONE },
      payload: { tags: [{ uuid: 'x', name: 'phone', hue: 1, isDefault: false, at: 9, origin: PHONE }] },
    });
    expect(d.tag('phone')).toBeUndefined();
  });

  it('drops a tombstone older than its time to live, and lists the younger ones', () => {
    let now = TAG_TOMBSTONE_TTL_MS + 1_000;
    const d = device(PRIMARY, { now: () => now });
    d.tagStore.tombstone('old-id', 'old');
    now += 500;
    d.tagStore.tombstone('new-id', 'new');
    now += TAG_TOMBSTONE_TTL_MS - 200;
    expect(d.sync.listTags().filter((t) => t.deleted).map((t) => t.uuid)).toEqual(['new-id']);
    expect(d.db.select().from(tagTombstones).all().map((t) => t.uuid)).toEqual(['new-id']);
  });

  it('matches same-name tags at the first catch-up: both keep the winner\'s id, and each its sessions and anchor', async () => {
    const primary = device(PRIMARY);
    const laptop = device(LAPTOP);
    const p = primary.addTag('work', 10, 0, { anchorX: 1, anchorY: 1 });
    const l = laptop.addTag('work', 200, 50, { anchorX: 9, anchorY: 9 });
    laptop.db.insert(sessionTags).values({ sessionId: 'mine', tagId: l.id, origin: 'manual' }).run();
    primary.addTag('home', 30);
    await pair(primary, laptop);
    // The laptop's later change wins; the seeded defaults, untouched on both, go to the primary's.
    for (const d of [primary, laptop]) {
      expect(d.tag('work')).toMatchObject({ uuid: l.uuid, hue: 200 });
      expect(d.tag('default')!.uuid).toBe(primary.tag('default')!.uuid);
      expect(d.tagNames()).toEqual(['default', 'home', 'work']);
    }
    expect(primary.tag('work')).toMatchObject({ id: p.id, anchorX: 1, anchorY: 1 });
    expect(laptop.tag('work')).toMatchObject({ id: l.id, anchorX: 9, anchorY: 9 });
    expect(laptop.tagged('mine')).toEqual([l.id]);
    expect(primary.tagsApplied.length).toBeGreaterThan(0);
  });

  it('a rename travels by group id, and a later push of an older state is ignored', async () => {
    let now = 100;
    const primary = device(PRIMARY, { now: () => now });
    const laptop = device(LAPTOP);
    const tag = primary.addTag('jobs', 10);
    await pair(primary, laptop);
    const before = laptop.tag('jobs')!;
    primary.db.update(tags).set({ name: 'work' }).where(eq(tags.id, tag.id)).run();
    primary.sync.tagChangedLocally(tag.id);
    await settle();
    expect(laptop.tag('work')).toMatchObject({ id: before.id, uuid: tag.uuid, stampAt: 100, stampOrigin: PRIMARY });
    expect(laptop.tag('jobs')).toBeUndefined();
    laptop.sync.receive({ tags: [{ uuid: tag.uuid, name: 'jobs', hue: 10, isDefault: false, at: 50, origin: BOX }] });
    expect(laptop.tag('work')?.id).toBe(before.id);
  });

  it('a rename onto a name another tag holds merges the two into the winner, sessions and rules with it', () => {
    const laptop = device(LAPTOP);
    const work = laptop.addTag('work', 10, 20);
    const jobs = laptop.addTag('jobs', 20, 10, { uuid: 'jobs-id' });
    laptop.db.insert(sessionTags).values([
      { sessionId: 'a', tagId: jobs.id, origin: 'manual' },
      { sessionId: 'b', tagId: work.id, origin: 'manual' },
      { sessionId: 'b', tagId: jobs.id, origin: 'manual' },
    ]).run();
    laptop.db.insert(tagRules).values({ tagId: jobs.id, position: 0, condition: 'title_contains', pattern: 'x' }).run();
    // Elsewhere, "jobs" was renamed "work" after this device's "work" was last changed.
    laptop.sync.receive({ tags: [{ uuid: 'jobs-id', name: 'work', hue: 20, isDefault: false, at: 30, origin: PRIMARY }] });
    expect(laptop.tagNames()).toEqual(['default', 'work']);
    expect(laptop.tag('work')).toMatchObject({ id: jobs.id, uuid: 'jobs-id', hue: 20 });
    expect(laptop.tagged('a')).toEqual([jobs.id]);
    expect(laptop.tagged('b')).toEqual([jobs.id]);
    expect(laptop.db.select().from(tagRules).all().map((r) => r.tagId)).toEqual([jobs.id]);
  });

  it('a rename that loses to the tag holding the name merges into that tag', () => {
    const laptop = device(LAPTOP);
    const work = laptop.addTag('work', 10, 50);
    const jobs = laptop.addTag('jobs', 20, 10, { uuid: 'jobs-id' });
    laptop.db.insert(sessionTags).values({ sessionId: 'a', tagId: jobs.id, origin: 'manual' }).run();
    laptop.sync.receive({ tags: [{ uuid: 'jobs-id', name: 'work', hue: 20, isDefault: false, at: 30, origin: PRIMARY }] });
    expect(laptop.tagNames()).toEqual(['default', 'work']);
    expect(laptop.tag('work')).toMatchObject({ id: work.id, hue: 10 });
    expect(laptop.tagged('a')).toEqual([work.id]);
  });

  it('a delete reaches an offline member at its catch-up, its sessions falling back; a later re-create wins over it', async () => {
    let now = 100;
    const primary = device(PRIMARY, { now: () => now });
    const laptop = device(LAPTOP);
    const tag = primary.addTag('work', 10);
    laptop.addTag('work', 10, 0, { uuid: tag.uuid });
    const onLaptop = laptop.tag('work')!;
    laptop.db.insert(sessionTags).values({ sessionId: 'a', tagId: onLaptop.id, origin: 'manual' }).run();
    laptop.db.insert(tagRules).values({ tagId: onLaptop.id, position: 0, condition: 'title_contains', pattern: 'a' }).run();
    // Deleted while the laptop is away.
    primary.db.delete(tags).where(eq(tags.id, tag.id)).run();
    primary.sync.tagDeletedLocally(tag.uuid!, 'work');
    await pair(primary, laptop);
    expect(laptop.tag('work')).toBeUndefined();
    expect(laptop.db.select().from(tagTombstones).get()).toMatchObject({ uuid: tag.uuid, stampAt: 100, stampOrigin: PRIMARY });
    // The same name made again later, under a new id: it wins over the tombstone everywhere.
    laptop.sync.receive({ tags: [{ uuid: 'new-id', name: 'work', hue: 50, isDefault: false, at: 200, origin: PRIMARY }] });
    expect(laptop.tag('work')).toMatchObject({ uuid: 'new-id', hue: 50 });
    // A copy of the deleted tag from before the delete does not come back.
    laptop.sync.receive({ tags: [{ uuid: 'old-copy', name: 'gone', hue: 1, isDefault: false, at: 50, origin: BOX }] });
    laptop.sync.receive({ tags: [{ uuid: 'gone-id', name: 'gone', hue: 0, isDefault: false, at: 60, origin: BOX, deleted: true }] });
    expect(laptop.tag('gone')).toBeUndefined();
    laptop.sync.receive({ tags: [{ uuid: 'older', name: 'gone', hue: 1, isDefault: false, at: 55, origin: BOX }] });
    expect(laptop.tag('gone')).toBeUndefined();
  });

  it('a tombstone of the default tag does not delete it: it is stamped anew and pushed back', async () => {
    let now = 500;
    const primary = device(PRIMARY);
    const laptop = device(LAPTOP, { now: () => now });
    await pair(primary, laptop);
    const def = laptop.tag('default')!;
    laptop.sync.receive({ tags: [{ uuid: def.uuid!, name: 'default', hue: 0, isDefault: false, at: 100, origin: BOX, deleted: true }] });
    await settle();
    expect(laptop.tag('default')).toMatchObject({ id: def.id, isDefault: 1, stampAt: 500, stampOrigin: '' });
    expect(primary.tag('default')).toMatchObject({ uuid: def.uuid, stampAt: 500, stampOrigin: LAPTOP });
  });

  it('a joining member takes the group\'s tags, and keeps and pushes those whose names the group lacks', async () => {
    let now = 1_000;
    const primary = device(PRIMARY);
    const laptop = device(LAPTOP, { now: () => now });
    primary.addTag('work', 10, 5);
    // Gone in the group long ago, under another id: the joining member's own tag of that name still stays.
    primary.tagStore.tombstone('old-id', 'personal');
    primary.db.update(tagTombstones).set({ stampAt: 7 }).run();
    laptop.addTag('work', 99, 900);
    laptop.addTag('personal', 40, 900);
    new GroupMembershipStore(laptop.db, () => LAPTOP).set({ group: PRIMARY, founding: 'f1', version: 1, member: true });
    expect(laptop.tag('work')).toMatchObject({ stampAt: -1, stampOrigin: '' });
    await pair(primary, laptop);
    for (const d of [primary, laptop]) {
      expect(d.tag('work')).toMatchObject({ hue: 10, uuid: primary.tag('work')!.uuid });
      expect(d.tag('personal')).toMatchObject({ hue: 40, uuid: laptop.tag('personal')!.uuid, stampAt: 1_000 });
    }
  });
});
