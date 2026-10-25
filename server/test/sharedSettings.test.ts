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
import { settings } from '../src/db/schema.js';
import { DEVICE_HEADER } from '../src/remote/inject.js';
import { GroupMembershipStore, joinsGroup } from '../src/remote/rosterStore.js';
import { SharedSettingsStore, SharedSettingsSync, registerSharedSettingsRoutes } from '../src/settings/sharedSettings.js';
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
}

/** One device: its database, its sync, its routes, and the roster it holds. */
function device(self: string, opts: { members?: MemberView[]; grants?: Record<string, boolean>; now?: () => number } = {}) {
  const db = openTmpDb('shared');
  const members = opts.members ?? [member(PRIMARY, 'desktop', true), member(LAPTOP), member(BOX, 'headless'), member(PHONE, 'phone')];
  const channels = new Map<string, FakeChannel>();
  const channelListeners = new Set<(id: string, c: Channel) => void>();
  const statusListeners = new Set<() => void>();
  const applied: Record<string, string>[] = [];
  const store = new SharedSettingsStore(db, () => self, opts.now);
  const sync = new SharedSettingsSync({
    store,
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
    db, store, sync, app, applied, members,
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
  };
}

/** Every request a fake channel was asked has been answered. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
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
    expect(d.store.stampOf('default_model')).toEqual({ at: 1_000 + SETTINGS_STAMP_SKEW_MS, origin: LAPTOP });
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
    expect(d.store.stampOf('confirm_before_clear')).toEqual({ at: 60, origin: LAPTOP });
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
    expect(d.store.stampOf('default_model')).toEqual({ at: 0, origin: PRIMARY });
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
    expect(primary.store.stampOf('default_model')).toEqual({ at: 900, origin: '' });
    expect(primary.store.stampOf('sidebar_width')).toEqual({ at: 0, origin: '' });
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
    expect(laptop.store.stampOf('default_model')).toEqual({ at: 0, origin: PRIMARY });
    expect(primary.store.stampOf('map_theme')).toEqual({ at: 70, origin: LAPTOP });
    // Once per channel.
    toLaptop.up();
    await settle();
    expect(toLaptop.request).toHaveBeenCalledTimes(1);
  });

  it('asks again once the member counts this device in its roster', async () => {
    const laptop = device(LAPTOP);
    // The primary has not taken the roster that adds the laptop yet.
    const primary = device(PRIMARY, { members: [member(PRIMARY, 'desktop', true)] });
    primary.set('default_model', 'opus', 10);
    const toPrimary = laptop.link(primary, PRIMARY);
    toPrimary.up();
    await settle();
    expect(laptop.value('default_model')).toBe('sonnet');
    primary.members.push(member(LAPTOP));
    laptop.statusChanged();
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
    expect(store.stampOf('default_model')?.at).toBe(80);
    membership.set({ group: PRIMARY, founding: 'f1', version: 1, member: true });
    expect(store.stampOf('default_model')?.at).toBe(-1);
    expect(store.stampOf('sidebar_width')?.at).toBe(80);
    // A later version of the same group resets nothing.
    store.stampLocal(['default_model']);
    membership.set({ group: PRIMARY, founding: 'f1', version: 2, member: true });
    expect(store.stampOf('default_model')?.at).toBeGreaterThan(0);
  });
});
