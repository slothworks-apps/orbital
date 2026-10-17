import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { TunnelError, type Channel, type ChannelEvent, type TunnelResponse } from '@orbital/shared/remote/channel';
import { capabilitiesOf } from '@orbital/shared/remote/device';
import { PROTOCOL_VERSION, type HelloMessage } from '@orbital/shared/remote/messages';
import { isLive, type RosterEntry } from '@orbital/shared/remote/roster';
import { Hub } from '../src/api/hub.js';
import { createImageStore } from '../src/images/store.js';
import { ServingHalf } from '../src/remote/servingHalf.js';
import { makeTmpDir, openTmpDb } from './tmp.js';
import { FederationService, SNAPSHOT_WRITE_MS, type FederationOptions } from '../src/federation/service.js';
import { MemberSnapshotStore } from '../src/federation/store.js';

const SELF = 'self';
const B = 'member-b';

function entry(id: string, patch: Partial<RosterEntry> = {}): RosterEntry {
  return {
    id, kind: 'desktop', name: id === SELF ? 'studio' : 'laptop', os: 'macos', links: true,
    epoch: 1, addedBy: SELF, addedAt: 1, describedAt: 1, ...patch,
  };
}

const desktopHello: HelloMessage = {
  t: 'hello', protocol: PROTOCOL_VERSION, kind: 'desktop', name: 'laptop', os: 'macos', capabilities: capabilitiesOf('desktop'),
};

/** What the federation uses of a `Channel`: no crypto, events by hand. */
class FakeChannel {
  ready = false;
  peer: HelloMessage | null = null;
  readonly subs = new Set<string>();
  readonly asked: string[] = [];
  private readonly listeners = new Set<(e: ChannelEvent) => void>();

  constructor(public answer: (method: string, path: string, body?: unknown) => TunnelResponse | Promise<TunnelResponse>) {}

  on(listener: (e: ChannelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribe(topic: string): void { this.subs.add(topic); }
  unsubscribe(topic: string): void { this.subs.delete(topic); }

  async request(method: string, path: string, body?: unknown): Promise<TunnelResponse> {
    this.asked.push(`${method} ${path}`);
    return this.answer(method, path, body);
  }

  emit(e: ChannelEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  greet(hello: HelloMessage): void {
    this.peer = hello;
    this.ready = true;
    this.emit({ type: 'hello', hello });
    this.emit({ type: 'ready', ready: true });
  }

  down(): void {
    this.ready = false;
    this.peer = null;
    this.emit({ type: 'ready', ready: false });
  }

  hub(frame: unknown): void {
    this.emit({ type: 'hub', frame });
  }
}

function fakeRemote(members: RosterEntry[]) {
  const channelListeners = new Set<(id: string, channel: Channel) => void>();
  const statusListeners = new Set<() => void>();
  const channels = new Map<string, Channel>();
  const remote = {
    members,
    onChannel(l: (id: string, channel: Channel) => void) { channelListeners.add(l); return () => { channelListeners.delete(l); }; },
    onStatus(l: () => void) { statusListeners.add(l); return () => { statusListeners.delete(l); }; },
    peerHello: (id: string) => (channels.get(id)?.peer ?? null),
    liveMembers: () => remote.members.filter(isLive),
    channel: (id: string) => channels.get(id) ?? null,
    selfId: () => SELF,
    /** A new channel to `id`, as `makeChannel` announces it. */
    open(id: string, channel: FakeChannel) {
      channels.set(id, channel as unknown as Channel);
      for (const l of channelListeners) l(id, channel as unknown as Channel);
    },
    published() { for (const l of statusListeners) l(); },
  };
  return remote;
}

/** A local window on the hub: what it subscribed to and every frame it got. */
function localSocket(hub: Hub, topics: string[]) {
  const socket = Object.assign(new EventEmitter(), { send: vi.fn() });
  hub.handleSocket(socket);
  for (const topic of topics) socket.emit('message', JSON.stringify({ type: 'subscribe', topic }));
  const frames = () => socket.send.mock.calls.map(([data]) => JSON.parse(data as string)).filter((f) => f.topic !== undefined);
  const unsubscribe = (topic: string) => socket.emit('message', JSON.stringify({ type: 'unsubscribe', topic }));
  return { frames, unsubscribe };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** B serves two sessions and a tag; asks for the first seed limit answer 413, as one too large for a frame. */
function memberB() {
  return new FakeChannel((_method, path) => {
    if (path === '/api/tags') return { status: 200, body: { tags: [{ id: 7, name: 'work', hue: 10 }, { id: 8, name: 'only-there' }] } };
    if (path === '/api/sessions?limit=200') return { status: 413, body: { error: 'too_large' } };
    if (path.startsWith('/api/sessions?limit=')) {
      return {
        status: 200,
        body: {
          sessions: [
            { id: 's1', status: 'working', tagIds: [7, 8] },
            // A third device's session B shows: not taken in.
            { id: 's3', status: 'working', machine: { id: 'c', name: 'other' } },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  });
}

function setup(members = [entry(SELF), entry(B)], opts: Partial<FederationOptions> = {}) {
  const hub = new Hub({ heartbeatIntervalMs: 60_000 });
  const remote = fakeRemote(members);
  let now = 1000;
  const federation = new FederationService({
    hub, remote, localTags: () => [{ id: 3, name: 'work', hue: 10 }], now: () => now, ...opts,
  });
  federation.start();
  return { hub, remote, federation, setNow: (t: number) => { now = t; } };
}

const machineB = { id: B, name: 'laptop', kind: 'desktop', os: 'macos' };

describe('FederationService', () => {
  it('seeds a member and republishes its sessions with its machine, tags mapped by name', async () => {
    const { hub, remote, federation } = setup();
    const win = localSocket(hub, ['sessions']);
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    expect(b.subs.has('sessions')).toBe(true);
    expect(b.asked).toEqual(['GET /api/tags', 'GET /api/sessions?limit=200', 'GET /api/sessions?limit=80']);
    const upsert = { event: 'upsert', session: { id: 's1', status: 'working', tagIds: [3], machine: { ...machineB, online: true, asOf: null } } };
    expect(win.frames()).toEqual([{ topic: 'sessions', ...upsert }]);
    expect(federation.sessions()).toEqual([upsert.session]);
    expect(federation.linkOf('s1')?.id).toBe(B);
    expect(federation.linkOf('s3')).toBeNull();
  });

  it('drops an upsert that carries a machine, and passes on its own upserts, statuses and removals', async () => {
    const { hub, remote, federation } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const win = localSocket(hub, ['sessions']);
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 'chained', machine: { id: 'c' } } });
    expect(win.frames()).toEqual([]);
    expect(federation.linkOf('chained')).toBeNull();
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 's2', status: 'working' } });
    b.hub({ topic: 'sessions', event: 'status', sessionId: 's2', status: 'needs_input' });
    b.hub({ topic: 'sessions', event: 'status', sessionId: 'unknown', status: 'needs_input' });
    b.hub({ topic: 'sessions', event: 'remove', sessionId: 's1' });
    expect(win.frames()).toEqual([
      { topic: 'sessions', event: 'upsert', session: { id: 's2', status: 'working', tagIds: [], machine: { ...machineB, online: true, asOf: null } } },
      { topic: 'sessions', event: 'status', sessionId: 's2', status: 'needs_input' },
      { topic: 'sessions', event: 'remove', sessionId: 's1' },
    ]);
    expect(federation.sessions().map((s) => [s.id, s.status])).toEqual([['s2', 'needs_input']]);
  });

  it('a channel that goes down republishes the member\'s sessions offline, as of then, and a new one seeds again', async () => {
    const { hub, remote, setNow } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const win = localSocket(hub, ['sessions']);
    setNow(5000);
    b.down();
    b.emit({ type: 'closed' });
    expect(win.frames()).toEqual([
      { topic: 'sessions', event: 'upsert', session: expect.objectContaining({ id: 's1', machine: { ...machineB, online: false, asOf: 5000 } }) },
    ]);
    const again = memberB();
    remote.open(B, again);
    again.greet(desktopHello);
    await flush();
    expect(again.subs.has('sessions')).toBe(true);
    expect(win.frames().at(-1)).toEqual({
      topic: 'sessions', event: 'upsert', session: expect.objectContaining({ id: 's1', machine: { ...machineB, online: true, asOf: null } }),
    });
    // The old channel speaks for nobody now.
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 'stale' } });
    expect(win.frames().some((f) => f.session?.id === 'stale')).toBe(false);
  });

  it('a member removed from the roster takes its sessions along; a renamed one is republished', async () => {
    const { hub, remote, federation } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const win = localSocket(hub, ['sessions']);
    remote.members = [entry(SELF), entry(B, { name: 'travel' })];
    remote.published();
    expect(win.frames()).toEqual([
      { topic: 'sessions', event: 'upsert', session: expect.objectContaining({ id: 's1', machine: expect.objectContaining({ name: 'travel' }) }) },
    ]);
    remote.published();
    expect(win.frames()).toHaveLength(1);
    remote.members = [entry(SELF), entry(B, { removedAt: 2, removedBy: SELF })];
    remote.published();
    expect(win.frames().at(-1)).toEqual({ topic: 'sessions', event: 'remove', sessionId: 's1' });
    expect(federation.sessions()).toEqual([]);
    expect(federation.link(B)).toBeNull();
  });

  it('leaves a phone and a member whose hello names no group alone: no subscription, nothing asked', async () => {
    const phone = 'phone-p';
    const old = 'old-mac';
    const { remote, federation } = setup([entry(SELF), entry(phone, { kind: 'phone', links: false }), entry(old)]);
    const p = memberB();
    const o = memberB();
    remote.open(phone, p);
    remote.open(old, o);
    p.greet({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'orbital-mobile/0.5.0' });
    o.greet({ t: 'hello', protocol: PROTOCOL_VERSION, server: '0.14.0', macName: 'old' });
    remote.published();
    await flush();
    for (const c of [p, o]) {
      expect(c.subs.size).toBe(0);
      expect(c.asked).toEqual([]);
    }
    expect(federation.link(phone)).toBeNull();
    expect(federation.link(old)).toBeNull();
  });

  it('a member whose channel came up before the roster held it is engaged when the roster catches up', async () => {
    const { remote, federation } = setup([entry(SELF)]);
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    expect(b.subs.size).toBe(0);
    remote.members = [entry(SELF), entry(B)];
    remote.published();
    await flush();
    expect(b.subs.has('sessions')).toBe(true);
    expect(federation.linkOf('s1')?.id).toBe(B);
  });

  it('per-session topics follow local subscribers, a spawn from here included; only the member\'s own reach the hub', async () => {
    const { hub, remote } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const win = localSocket(hub, ['session:s1', 'subagent:s1:a1', 'session:spawned', 'presence', 'session:elsewhere']);
    expect([...b.subs].sort()).toEqual(['presence', 'session:s1', 'sessions', 'subagent:s1:a1']);
    // The window opened before B's list carried the id.
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 'spawned', status: 'working' } });
    expect(b.subs.has('session:spawned')).toBe(true);
    b.hub({ topic: 'session:s1', event: 'message', text: 'hi' });
    b.hub({ topic: 'presence', event: 'state', atMac: true });
    b.hub({ topic: 'session:elsewhere', event: 'message' });
    expect(win.frames()).toEqual([{ topic: 'session:s1', event: 'message', text: 'hi' }]);
    win.unsubscribe('session:s1');
    expect(b.subs.has('session:s1')).toBe(false);
  });

  it('request: offline is 409, a tunnel failure 502, and a session in the answer is localized', async () => {
    const { remote, federation } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const link = federation.link(B)!;
    b.answer = () => ({ status: 200, body: { session: { id: 's1', tagIds: [7] } } });
    expect(await federation.request(link, 'GET', '/api/sessions/s1')).toEqual({
      status: 200, body: { session: { id: 's1', tagIds: [3], machine: { ...machineB, online: true, asOf: null } } },
    });
    b.answer = () => { throw new TunnelError('timeout'); };
    expect(await federation.request(link, 'GET', '/api/health')).toEqual({ status: 502, body: { error: 'member_unreachable' } });
    b.down();
    expect(await federation.request(link, 'GET', '/api/health')).toEqual({ status: 409, body: { error: 'member_offline' } });
  });

  it('a peer of this server never sees the remove of a federated session, from the member or from a roster drop', async () => {
    const { hub, remote, federation } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 's2', status: 'working' } });
    // A peer served here, wired as `buildServer` wires it.
    const dir = makeTmpDir('federation');
    const peer: unknown[] = [];
    const serving = new ServingHalf({
      deviceId: 'peer', hub, inject: async () => ({ statusCode: 500, body: '{}' }), images: createImageStore(dir), imagesDir: dir,
      files: () => ({ status: 404 }), notifications: { get: () => ({}) as never, set: () => {} }, onSeen: () => {},
      foreign: (id) => federation.linkOf(id) !== null,
    });
    serving.open({ json: (msg) => { peer.push(msg); }, inner: () => {} });
    serving.ask({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    const win = localSocket(hub, ['sessions']);
    b.hub({ topic: 'sessions', event: 'remove', sessionId: 's2' });
    remote.members = [entry(SELF)];
    remote.published();
    expect(win.frames()).toEqual([
      { topic: 'sessions', event: 'remove', sessionId: 's2' },
      { topic: 'sessions', event: 'remove', sessionId: 's1' },
    ]);
    expect(peer.filter((m: any) => m.frame?.topic === 'sessions')).toEqual([]);
    // The dropped member's channel is not left streaming.
    expect(b.subs.has('sessions')).toBe(false);
    expect(b.subs.has('presence')).toBe(false);
    serving.reset();
  });

  it('stop forgets every member and listens no more', async () => {
    const { hub, remote, federation } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    federation.stop();
    const win = localSocket(hub, ['sessions', 'session:s1']);
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 's9' } });
    expect(win.frames()).toEqual([]);
    expect(federation.sessions()).toEqual([]);
    expect(b.subs.has('session:s1')).toBe(false);
  });
});

describe('FederationService snapshots', () => {
  afterEach(() => vi.useRealTimers());

  it('a member that went offline is still listed after a restart, offline as of when it was last heard from', async () => {
    const store = new MemberSnapshotStore(openTmpDb('federation'));
    const first = setup(undefined, { snapshots: store });
    const b = memberB();
    first.remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    first.setNow(5000);
    b.down();
    // Written at once, not after the gathering delay.
    expect(store.load()).toEqual([
      { memberId: B, sessions: [{ id: 's1', status: 'working', tagIds: [7, 8] }], tags: expect.arrayContaining([{ id: 7, name: 'work', hue: 10 }]), seenAt: 5000 },
    ]);
    first.federation.stop();

    const second = setup(undefined, { snapshots: store });
    second.setNow(99_000);
    expect(second.federation.sessions()).toEqual([
      { id: 's1', status: 'working', tagIds: [3], machine: { ...machineB, online: false, asOf: 5000 } },
    ]);
    expect(second.federation.linkOf('s1')?.id).toBe(B);
    // Its channel comes up: the seed replaces what was kept.
    const again = memberB();
    second.remote.open(B, again);
    again.greet(desktopHello);
    await flush();
    expect(second.federation.sessions()).toEqual([
      { id: 's1', status: 'working', tagIds: [3], machine: { ...machineB, online: true, asOf: null } },
    ]);
  });

  it('drops at start the snapshot of a member no longer in the group, of a phone and of this device', () => {
    const store = new MemberSnapshotStore(openTmpDb('federation'));
    for (const id of ['gone', 'removed', 'phone-p', SELF, B]) store.save(id, [{ id: `s-${id}` }], [], 1);
    const { federation } = setup(
      [entry(SELF), entry(B), entry('removed', { removedAt: 2, removedBy: SELF }), entry('phone-p', { kind: 'phone', links: false })],
      { snapshots: store },
    );
    expect(store.load().map((s) => s.memberId)).toEqual([B]);
    expect(federation.sessions().map((s) => s.id)).toEqual([`s-${B}`]);
  });

  it('keeps nothing and drops nothing while the roster holds no self', () => {
    const store = new MemberSnapshotStore(openTmpDb('federation'));
    store.save(B, [{ id: 's1' }], [], 1);
    const { federation } = setup([], { snapshots: store });
    expect(federation.sessions()).toEqual([]);
    expect(store.load()).toHaveLength(1);
  });

  it('gathers a member\'s changes into one write, keeps the newest seed-limit sessions, and flushes at stop', async () => {
    vi.useFakeTimers();
    const saves: { sessions: { id: string }[]; seenAt: number }[] = [];
    const snapshots = { load: () => [], remove: () => {}, save: (_id: string, sessions: { id: string }[], _tags: unknown, seenAt: number) => { saves.push({ sessions, seenAt }); } };
    const { remote, federation, setNow } = setup(undefined, { snapshots });
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 205; i++) b.hub({ topic: 'sessions', event: 'upsert', session: { id: `n${i}`, lastAt: i } });
    b.hub({ topic: 'sessions', event: 'status', sessionId: 'n0', status: 'needs_input' });
    setNow(7000);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_MS - 1);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toHaveLength(1);
    // Up: heard from now.
    expect(saves[0].seenAt).toBe(7000);
    // The seed's limit, the oldest by `lastAt` dropped (s1 has none).
    expect(saves[0].sessions).toHaveLength(200);
    expect(saves[0].sessions.some((s) => s.id === 's1' || s.id === 'n0')).toBe(false);
    expect(saves[0].sessions.some((s) => s.id === 'n204')).toBe(true);
    b.hub({ topic: 'sessions', event: 'remove', sessionId: 'n204' });
    federation.stop();
    expect(saves).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_MS * 2);
    expect(saves).toHaveLength(2);
  });

  it('a member removed from the group takes its snapshot along', async () => {
    const store = new MemberSnapshotStore(openTmpDb('federation'));
    const { remote } = setup(undefined, { snapshots: store });
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    b.down();
    expect(store.load()).toHaveLength(1);
    remote.members = [entry(SELF)];
    remote.published();
    expect(store.load()).toEqual([]);
  });
});

describe('FederationService alone in its group', () => {
  afterEach(() => vi.useRealTimers());

  it('a device left in a group of one forgets every member: removes published first, every snapshot row gone', async () => {
    const store = new MemberSnapshotStore(openTmpDb('federation'));
    const { hub, remote, federation } = setup(undefined, { snapshots: store });
    const window = localSocket(hub, ['sessions']);
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    b.down();
    // A row no link holds, as one left from before: it goes too.
    store.save('stale', [{ id: 'old' }], [], 1);
    expect(store.load()).toHaveLength(2);
    remote.members = [entry(SELF), entry('phone-p', { kind: 'phone', links: false })];
    remote.published();
    expect(federation.sessions()).toEqual([]);
    expect(store.load()).toEqual([]);
    expect(window.frames()).toContainEqual({ topic: 'sessions', event: 'remove', sessionId: 's1' });
  });

  it('a tag made on a member after stop does not hold up the next link\'s write', async () => {
    vi.useFakeTimers();
    const saves: string[] = [];
    const snapshots = { load: () => [], remove: () => {}, save: (id: string) => { saves.push(id); } };
    const { remote, federation } = setup(undefined, { snapshots, localTags: () => [{ id: 4, name: 'new' }] });
    let made!: (res: TunnelResponse) => void;
    const seedAnswer = memberB().answer;
    const b = new FakeChannel((method, path, body) => (method === 'POST' && path === '/api/tags'
      ? new Promise<TunnelResponse>((r) => { made = r; })
      : seedAnswer(method, path, body)));
    remote.open(B, b);
    b.greet(desktopHello);
    await vi.advanceTimersByTimeAsync(0);
    const tag = federation.peerTagId(federation.link(B)!, 4);
    federation.stop();
    saves.length = 0;
    made({ status: 201, body: { id: 9 } });
    await tag;
    // Up again: the new link's seed is written after the gathering delay.
    federation.start();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_MS);
    expect(saves).toEqual([B]);
  });
});

describe('FederationService presence', () => {
  it('the user at a member keeps the phone quiet here, until that member\'s channel is down', async () => {
    const { remote, federation } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    expect(b.subs.has('presence')).toBe(true);
    expect(federation.presentElsewhere()).toBe(false);
    b.hub({ topic: 'presence', event: 'state', atMac: true });
    expect(federation.presentElsewhere()).toBe(true);
    b.hub({ topic: 'presence', event: 'state', atMac: false });
    expect(federation.presentElsewhere()).toBe(false);
    b.hub({ topic: 'presence', event: 'state', atMac: true });
    b.down();
    expect(federation.presentElsewhere()).toBe(false);
  });

  it('a member without the presence capability is not asked for it', async () => {
    const { remote, federation } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet({ ...desktopHello, kind: 'headless', capabilities: capabilitiesOf('headless') });
    await flush();
    expect(b.subs.has('sessions')).toBe(true);
    expect(b.subs.has('presence')).toBe(false);
    expect(federation.presentElsewhere()).toBe(false);
  });
});
