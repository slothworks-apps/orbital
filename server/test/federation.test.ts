import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { TunnelError, type BlobResult, type Channel, type ChannelEvent, type TunnelResponse } from '@orbital/shared/remote/channel';
import { capabilitiesOf } from '@orbital/shared/remote/device';
import { PROTOCOL_VERSION, type HelloMessage } from '@orbital/shared/remote/messages';
import type { MemberView } from '@orbital/shared/remote/roster';
import { Hub } from '../src/api/hub.js';
import { createImageStore } from '../src/images/store.js';
import { ServingHalf } from '../src/remote/servingHalf.js';
import { makeTmpDir, openTmpDb } from './tmp.js';
import { registerFederationRoutes } from '../src/federation/routes.js';
import { FederationService, MEMBER_SESSIONS_MAX, SEED_RETRY_MS, SNAPSHOT_WRITE_MS, type FederationOptions } from '../src/federation/service.js';
import { MemberSnapshotStore } from '../src/federation/store.js';
import { ReadCache } from '../src/federation/readCache.js';

const SELF = 'self';
const B = 'member-b';

/** A member as the remote lists it; `removedAt` marks one the latest version no longer names. */
type Entry = MemberView & { removedAt?: number; removedBy?: string };

function entry(id: string, patch: Partial<Entry> = {}): Entry {
  return { id, kind: 'desktop', name: id === SELF ? 'studio' : 'laptop', os: 'macos', links: true, addedAt: 1, addedVersion: 1, primary: id === SELF, ...patch };
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
  /** How this member answers a `blob_get`; by default it holds nothing. */
  blob: (ref: string) => Promise<BlobResult> = async () => ({ status: 404, bytes: new Uint8Array(), mediaType: null });
  private readonly listeners = new Set<(e: ChannelEvent) => void>();

  constructor(public answer: (method: string, path: string, body?: unknown) => TunnelResponse | Promise<TunnelResponse>) {}

  on(listener: (e: ChannelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribe(topic: string): void { this.subs.add(topic); }
  unsubscribe(topic: string): void { this.subs.delete(topic); }

  getBlob(ref: string): Promise<BlobResult> { return this.blob(ref); }

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

function fakeRemote(members: Entry[]) {
  const channelListeners = new Set<(id: string, channel: Channel) => void>();
  const statusListeners = new Set<() => void>();
  const channels = new Map<string, Channel>();
  const remote = {
    members,
    onChannel(l: (id: string, channel: Channel) => void) { channelListeners.add(l); return () => { channelListeners.delete(l); }; },
    onStatus(l: () => void) { statusListeners.add(l); return () => { statusListeners.delete(l); }; },
    peerHello: (id: string) => (channels.get(id)?.peer ?? null),
    liveMembers: (): MemberView[] => remote.members.filter((e) => e.removedAt === undefined),
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

  it('a channel that goes down marks the member offline in one frame, as of then, and a new one seeds again', async () => {
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
      { topic: 'sessions', event: 'machine', machine: { ...machineB, online: false, asOf: 5000 } },
    ]);
    const again = memberB();
    remote.open(B, again);
    again.greet(desktopHello);
    await flush();
    expect(again.subs.has('sessions')).toBe(true);
    // The list is what it was: no upsert, only the member back online.
    expect(win.frames().slice(1)).toEqual([
      { topic: 'sessions', event: 'machine', machine: { ...machineB, online: true, asOf: null } },
    ]);
    // The old channel speaks for nobody now.
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 'stale' } });
    expect(win.frames().some((f) => f.session?.id === 'stale')).toBe(false);
  });

  it('a member removed from the roster takes its sessions along; a renamed one is told in one frame', async () => {
    const { hub, remote, federation } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const win = localSocket(hub, ['sessions']);
    remote.members = [entry(SELF), entry(B, { name: 'travel' })];
    remote.published();
    expect(win.frames()).toEqual([
      { topic: 'sessions', event: 'machine', machine: { ...machineB, name: 'travel', online: true, asOf: null } },
    ]);
    expect(federation.sessions()[0].machine).toMatchObject({ name: 'travel' });
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
    // An answer naming another session than the one asked: that session is left out, here and in a read.
    b.answer = () => ({ status: 200, body: { session: { id: 'other' }, extra: 1 } });
    expect(await federation.request(link, 'GET', '/api/sessions/s1')).toEqual({ status: 200, body: { extra: 1 } });
    expect(await federation.read(link, 's1', '/api/sessions/s1')).toEqual({ status: 200, body: { extra: 1 } });
    expect(await federation.request(link, 'POST', '/api/sessions')).toEqual({ status: 200, body: { extra: 1 } });
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

  it('a peer of this server never gets a member\'s machine frame', async () => {
    const { hub, remote, federation, setNow } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
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
    setNow(5000);
    b.down();
    expect(win.frames().map((f) => f.event)).toEqual(['machine']);
    expect(peer.filter((m: any) => m.frame?.topic === 'sessions')).toEqual([]);
    serving.reset();
  });

  it('a spawn on a member from here: its topics are asked of the member first, and its frames taken in before its list names it', async () => {
    const { hub, remote, federation } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const win = localSocket(hub, ['session:minted', 'subagent:minted:a1']);
    expect(b.subs.has('session:minted')).toBe(false);
    federation.expect(federation.link(B)!, 'minted');
    expect(b.subs.has('session:minted')).toBe(true);
    expect(b.subs.has('subagent:minted:a1')).toBe(true);
    expect(federation.linkOf('minted')?.id).toBe(B);
    b.hub({ topic: 'session:minted', event: 'status', status: 'working' });
    expect(win.frames()).toEqual([{ topic: 'session:minted', event: 'status', status: 'working' }]);
    // The list names it: one owner, by the list.
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 'minted', status: 'working' } });
    expect(federation.linkOf('minted')?.id).toBe(B);
    // A spawn the member refused gives its topics back and is nobody's.
    const waiting = localSocket(hub, ['session:refused']);
    federation.expect(federation.link(B)!, 'refused');
    federation.unexpect(federation.link(B)!, 'refused');
    expect(b.subs.has('session:refused')).toBe(false);
    expect(federation.linkOf('refused')).toBeNull();
    b.hub({ topic: 'session:refused', event: 'status', status: 'working' });
    expect(waiting.frames()).toEqual([]);
  });

  it('an id of this device\'s own session is never expected of a member', async () => {
    const { hub, remote, federation } = setup(undefined, { localSession: (id) => id === 'mine' });
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const win = localSocket(hub, ['session:mine']);
    federation.expect(federation.link(B)!, 'mine');
    expect(federation.linkOf('mine')).toBeNull();
    expect(b.subs.has('session:mine')).toBe(false);
    // B's word about it is not taken in as this device's.
    b.hub({ topic: 'session:mine', event: 'status', status: 'working' });
    expect(win.frames()).toEqual([]);
  });

  it('an image is asked of every member that is up at once; the first that holds it answers', async () => {
    const C = 'member-c';
    const { remote, federation } = setup([entry(SELF), entry(B), entry(C)]);
    const b = memberB();
    const c = memberB();
    remote.open(B, b);
    remote.open(C, c);
    b.greet(desktopHello);
    c.greet(desktopHello);
    await flush();
    // B never answers; C holds the image.
    b.blob = () => new Promise(() => {});
    const held: BlobResult = { status: 200, bytes: new Uint8Array([1, 2]), mediaType: 'image/png' };
    const ref = `${createHash('sha256').update(held.bytes).digest('hex')}.png`;
    c.blob = async () => held;
    expect(await federation.blob(ref)).toBe(held);
    c.blob = async () => ({ status: 404, bytes: new Uint8Array(), mediaType: null });
    b.blob = async () => { throw new TunnelError('timeout'); };
    expect(await federation.blob(ref)).toBeNull();
  });

  it('an image answer whose bytes are not the ref\'s does not end the search', async () => {
    const C = 'member-c';
    const { remote, federation } = setup([entry(SELF), entry(B), entry(C)]);
    const b = memberB();
    const c = memberB();
    remote.open(B, b);
    remote.open(C, c);
    b.greet(desktopHello);
    c.greet(desktopHello);
    await flush();
    const held: BlobResult = { status: 200, bytes: new Uint8Array([1, 2]), mediaType: 'image/png' };
    const ref = `${createHash('sha256').update(held.bytes).digest('hex')}.png`;
    // B answers at once with other bytes; C, later, with the ref's.
    b.blob = async () => ({ status: 200, bytes: new Uint8Array([6, 6, 6]), mediaType: 'image/png' });
    c.blob = () => new Promise((r) => setTimeout(() => r(held), 5));
    expect(await federation.blob(ref)).toBe(held);
    c.blob = b.blob;
    expect(await federation.blob(ref)).toBeNull();
  });

  it('reads this device\'s tags once, not per frame, and again after they change', async () => {
    const localTags = vi.fn(() => [{ id: 3, name: 'work', hue: 10 }]);
    const { remote, federation } = setup(undefined, { localTags });
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const reads = localTags.mock.calls.length;
    for (let i = 0; i < 5; i++) b.hub({ topic: 'sessions', event: 'upsert', session: { id: 's1', status: 'working', tagIds: [7] } });
    expect(localTags.mock.calls.length).toBe(reads);
    localTags.mockReturnValue([{ id: 4, name: 'work', hue: 10 }]);
    federation.tagsChanged();
    expect(federation.sessions()[0].tagIds).toEqual([4]);
  });

  it('a member cannot take a session id another member, or this device, holds', async () => {
    const C = 'member-c';
    const { hub, remote, federation } = setup([entry(SELF), entry(B), entry(C)], { localSession: (id) => id === 'mine' });
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    // C lists B's session and this device's own, and announces them again.
    const c = new FakeChannel((_method, path) => {
      if (path === '/api/tags') return { status: 200, body: { tags: [] } };
      if (path.startsWith('/api/sessions?limit=')) return { status: 200, body: { sessions: [{ id: 's1' }, { id: 'mine' }, { id: 'c1' }] } };
      return { status: 404, body: {} };
    });
    remote.open(C, c);
    c.greet(desktopHello);
    await flush();
    const win = localSocket(hub, ['sessions', 'session:s1']);
    c.hub({ topic: 'sessions', event: 'upsert', session: { id: 's1', title: 'taken' } });
    c.hub({ topic: 'sessions', event: 'upsert', session: { id: 'mine' } });
    c.hub({ topic: 'session:s1', event: 'message' });
    expect(win.frames()).toEqual([]);
    expect(federation.linkOf('s1')?.id).toBe(B);
    expect(federation.linkOf('mine')).toBeNull();
    expect(federation.linkOf('c1')?.id).toBe(C);
    expect(c.subs.has('session:s1')).toBe(false);
  });

  it.each(['../tags', 'a/b', 'x?machine=c', 'x#y', '%2e%2e', '..', '', 'count', 'a:b'])(
    'a session id that is not a safe path segment never enters the hub: %j',
    async (id) => {
      const { hub, remote, federation } = setup();
      const b = new FakeChannel((_method, path) => {
        if (path === '/api/tags') return { status: 200, body: { tags: [] } };
        if (path.startsWith('/api/sessions?limit=')) return { status: 200, body: { sessions: [{ id }, { id: 'ok-1' }] } };
        return { status: 404, body: {} };
      });
      remote.open(B, b);
      b.greet(desktopHello);
      await flush();
      const win = localSocket(hub, ['sessions']);
      b.hub({ topic: 'sessions', event: 'upsert', session: { id } });
      expect(win.frames()).toEqual([]);
      expect(federation.linkOf(id)).toBeNull();
      expect(federation.sessions().map((s) => s.id)).toEqual(['ok-1']);
      expect(federation.localizeList(federation.link(B)!, [{ id }]).length).toBe(0);
    },
  );

  it('holds at most MEMBER_SESSIONS_MAX sessions of a member, by seed and by upsert, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { remote, federation } = setup();
      const many = Array.from({ length: MEMBER_SESSIONS_MAX + 5 }, (_, i) => ({ id: `s${i}` }));
      const b = new FakeChannel((_method, path) => {
        if (path === '/api/tags') return { status: 200, body: { tags: [] } };
        if (path.startsWith('/api/sessions?limit=')) return { status: 200, body: { sessions: many } };
        return { status: 404, body: {} };
      });
      remote.open(B, b);
      b.greet(desktopHello);
      await flush();
      expect(federation.sessions()).toHaveLength(MEMBER_SESSIONS_MAX);
      b.hub({ topic: 'sessions', event: 'upsert', session: { id: 'new-1' } });
      b.hub({ topic: 'sessions', event: 'upsert', session: { id: 'new-2' } });
      expect(federation.linkOf('new-1')).toBeNull();
      // One already held still changes.
      b.hub({ topic: 'sessions', event: 'upsert', session: { id: 's0', status: 'working' } });
      expect(federation.sessions().find((s) => s.id === 's0')?.status).toBe('working');
      expect(warn.mock.calls.filter(([m]) => String(m).includes('more are not taken in'))).toHaveLength(1);
      // Room again: a new one is taken in.
      b.hub({ topic: 'sessions', event: 'remove', sessionId: 's1' });
      b.hub({ topic: 'sessions', event: 'upsert', session: { id: 'new-3' } });
      expect(federation.linkOf('new-3')?.id).toBe(B);
    } finally {
      warn.mockRestore();
    }
  });

  it('a member\'s 401 reaches the window as 502 member_refused, not as this device\'s own', async () => {
    const { remote, federation } = setup();
    const b = new FakeChannel((_method, path) => {
      if (path === '/api/tags') return { status: 200, body: { tags: [] } };
      if (path.startsWith('/api/sessions?limit=')) return { status: 200, body: { sessions: [{ id: 's1' }] } };
      return { status: 401, body: { error: 'unauthorized' } };
    });
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const app = Fastify();
    app.decorateRequest('isMultipart', () => false);
    registerFederationRoutes(app, federation, () => SELF, makeTmpDir('federation-routes'), { bytes: () => null });
    app.get('/api/sessions/:id', async () => ({ local: true }));
    app.post('/api/sessions/:id/interrupt', async () => ({ local: true }));
    try {
      for (const [method, url] of [['GET', '/api/sessions/s1'], ['POST', '/api/sessions/s1/interrupt']] as const) {
        const res = await app.inject({ method, url });
        expect(res.statusCode).toBe(502);
        expect(res.json()).toEqual({ error: 'member_refused' });
      }
    } finally {
      await app.close();
    }
  });

  it('a page that opens a member\'s session is this device\'s own, the member offline or not', async () => {
    const { remote, federation } = setup();
    const b = new FakeChannel((_method, path) => {
      if (path === '/api/tags') return { status: 200, body: { tags: [] } };
      if (path.startsWith('/api/sessions?limit=')) return { status: 200, body: { sessions: [{ id: 's1' }] } };
      return { status: 200, body: { member: true } };
    });
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const app = Fastify();
    app.decorateRequest('isMultipart', () => false);
    registerFederationRoutes(app, federation, () => SELF, makeTmpDir('federation-routes'), { bytes: () => null });
    app.get('/', async () => ({ page: true }));
    try {
      expect((await app.inject({ method: 'GET', url: '/?session=s1' })).json()).toEqual({ page: true });
      b.down();
      const res = await app.inject({ method: 'GET', url: '/?session=s1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ page: true });
    } finally {
      await app.close();
    }
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

describe('FederationService seed failures', () => {
  afterEach(() => vi.useRealTimers());

  /** B as `memberB`, but its list answers `listStatus` until `heal()`. */
  function failingB(listStatus: number) {
    let failing = true;
    const ok = memberB();
    const channel = new FakeChannel((method, path) => {
      if (failing && path.startsWith('/api/sessions?limit=')) return { status: listStatus, body: { error: 'x' } };
      return ok.answer(method, path);
    });
    return { channel, heal: () => { failing = false; } };
  }

  it('a member whose list cannot be read stays offline as of when it was last read, and is asked again until it can', async () => {
    vi.useFakeTimers();
    const { hub, remote, federation, setNow } = setup();
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await vi.advanceTimersByTimeAsync(0);
    setNow(5000);
    b.down();
    const win = localSocket(hub, ['sessions']);
    setNow(9000);
    const again = failingB(500);
    remote.open(B, again.channel);
    again.channel.greet(desktopHello);
    await vi.advanceTimersByTimeAsync(0);
    // Up, but nothing read: still offline as of 5000, and nothing said otherwise.
    expect(federation.sessions()[0].machine).toEqual({ ...machineB, online: false, asOf: 5000 });
    expect(win.frames()).toEqual([]);
    const asked = () => again.channel.asked.filter((a) => a.startsWith('GET /api/sessions')).length;
    expect(asked()).toBe(1);
    await vi.advanceTimersByTimeAsync(SEED_RETRY_MS);
    expect(asked()).toBe(2);
    again.heal();
    // The next wait is longer: the backoff doubles.
    await vi.advanceTimersByTimeAsync(SEED_RETRY_MS);
    expect(asked()).toBe(2);
    await vi.advanceTimersByTimeAsync(SEED_RETRY_MS);
    expect(asked()).toBeGreaterThan(2);
    expect(federation.sessions()[0].machine).toEqual({ ...machineB, online: true, asOf: null });
    expect(win.frames().at(-1)).toEqual({ topic: 'sessions', event: 'machine', machine: { ...machineB, online: true, asOf: null } });
    // Read once: no more asking.
    const settled = asked();
    await vi.advanceTimersByTimeAsync(SEED_RETRY_MS * 100);
    expect(asked()).toBe(settled);
  });

  it('a first seed that fails marks what the member already sent offline; every limit too large is a failure too', async () => {
    vi.useFakeTimers();
    const { hub, remote, federation, setNow } = setup();
    const win = localSocket(hub, ['sessions']);
    setNow(3000);
    const b = failingB(413);
    remote.open(B, b.channel);
    b.channel.greet(desktopHello);
    // A live upsert arrives before the list fails.
    b.channel.hub({ topic: 'sessions', event: 'upsert', session: { id: 'live', status: 'working' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.channel.asked).toEqual(['GET /api/tags', 'GET /api/sessions?limit=200', 'GET /api/sessions?limit=80', 'GET /api/sessions?limit=30']);
    expect(federation.sessions()[0].machine).toEqual({ ...machineB, online: false, asOf: 3000 });
    expect(win.frames().at(-1)).toEqual({ topic: 'sessions', event: 'machine', machine: { ...machineB, online: false, asOf: 3000 } });
  });

  it('a retry stops with the channel', async () => {
    vi.useFakeTimers();
    const { remote } = setup();
    const b = failingB(502);
    remote.open(B, b.channel);
    b.channel.greet(desktopHello);
    await vi.advanceTimersByTimeAsync(0);
    b.channel.down();
    const before = b.channel.asked.length;
    await vi.advanceTimersByTimeAsync(SEED_RETRY_MS * 10);
    expect(b.channel.asked.length).toBe(before);
  });
});

describe('FederationService errors that are not the network', () => {
  it('upload and file pass on what is not a channel failure, and answer null for one', async () => {
    const { remote, federation } = setup();
    const b = memberB() as FakeChannel & { putBlob?: unknown; getFile?: unknown };
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    const link = federation.link(B)!;
    const image = () => ({ bytes: new Uint8Array([1]), mediaType: 'image/png' });
    b.putBlob = async () => { throw new TunnelError('lost'); };
    b.getFile = async () => { throw new TunnelError('lost'); };
    expect(await federation.upload(link, ['r'], image)).toBeNull();
    expect(await federation.file(link, 's1', '/a', 'raw' as never)).toBeNull();
    b.putBlob = async () => { throw new TypeError('bug'); };
    b.getFile = async () => { throw new TypeError('bug'); };
    await expect(federation.upload(link, ['r'], image)).rejects.toThrow('bug');
    await expect(federation.file(link, 's1', '/a', 'raw' as never)).rejects.toThrow('bug');
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

  it('a start engages a member kept from before whose channel is up already', async () => {
    const store = new MemberSnapshotStore(openTmpDb('federation'));
    const { remote, federation } = setup(undefined, { snapshots: store });
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    // Kept at stop; the start restores B from it, and no hello or ready is coming.
    federation.stop();
    b.subs.clear();
    federation.start();
    await flush();
    expect(b.subs.has('sessions')).toBe(true);
    expect(federation.sessions()[0].machine).toMatchObject({ online: true, asOf: null });
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

  it('a change of status or lastAt alone schedules no write; any other change writes once per SNAPSHOT_WRITE_MS', async () => {
    vi.useFakeTimers();
    const saves: unknown[] = [];
    const snapshots = { load: () => [], remove: () => {}, save: (...args: unknown[]) => { saves.push(args); } };
    const { remote } = setup(undefined, { snapshots });
    const b = memberB();
    remote.open(B, b);
    b.greet(desktopHello);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_MS);
    // The seed's own write.
    expect(saves).toHaveLength(1);
    b.hub({ topic: 'sessions', event: 'status', sessionId: 's1', status: 'idle' });
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 's1', status: 'working', tagIds: [7, 8], lastAt: 50 } });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_MS * 3);
    expect(saves).toHaveLength(1);
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 's1', status: 'working', tagIds: [7, 8], lastAt: 60, title: 'named' } });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_MS / 2);
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 's2', status: 'working' } });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_MS / 2 - 1);
    expect(saves).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toHaveLength(2);
    // Going offline still writes at once.
    b.down();
    expect(saves).toHaveLength(3);
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

describe('FederationService read cache', () => {
  /** B up and seeded, answering every read of s1 with `body`. */
  async function readable(opts: Partial<FederationOptions> = {}) {
    const ctx = setup(undefined, opts);
    const b = memberB();
    const seed = b.answer;
    let body: unknown = { messages: ['hi'] };
    b.answer = (method, path, reqBody) => (path.startsWith('/api/sessions/') ? { status: 200, body } : seed(method, path, reqBody));
    ctx.remote.open(B, b);
    b.greet(desktopHello);
    await flush();
    return { ...ctx, b, link: ctx.federation.link(B)!, answerWith: (next: unknown) => { body = next; } };
  }

  it('a read answered while the member was up is answered from the copy once it is offline, with when it was kept', async () => {
    const { federation, b, link, setNow } = await readable();
    setNow(5000);
    expect(await federation.read(link, 's1', '/api/sessions/s1/messages?limit=50')).toEqual({ status: 200, body: { messages: ['hi'] } });
    b.down();
    setNow(9000);
    expect(await federation.read(link, 's1', '/api/sessions/s1/messages?limit=50'))
      .toEqual({ status: 200, body: { messages: ['hi'] }, asOf: 5000 });
    // Another url of the same session was never read: no copy.
    expect(await federation.read(link, 's1', '/api/sessions/s1/messages?limit=10'))
      .toEqual({ status: 409, body: { error: 'member_offline' } });
  });

  it('a kept session names its member as it is now: offline', async () => {
    const { federation, b, link, answerWith } = await readable();
    answerWith({ session: { id: 's1', tagIds: [7] } });
    await federation.read(link, 's1', '/api/sessions/s1');
    b.down();
    const res = await federation.read(link, 's1', '/api/sessions/s1');
    expect((res.body as any).session.machine).toEqual({ ...machineB, online: false, asOf: 1000 });
    expect((res.body as any).session.tagIds).toEqual([3]);
  });

  it('keeps no answer but a 200, and none of a session the member no longer lists', async () => {
    const { federation, b, link } = await readable();
    b.answer = () => ({ status: 404, body: { error: 'not_found' } });
    await federation.read(link, 's1', '/api/sessions/s1');
    b.answer = () => ({ status: 200, body: { session: { id: 'gone' } } });
    await federation.read(link, 'gone', '/api/sessions/gone');
    b.down();
    expect((await federation.read(link, 's1', '/api/sessions/s1')).status).toBe(409);
    expect((await federation.read(link, 'gone', '/api/sessions/gone')).status).toBe(409);
  });

  it('a session the member removed, and a member removed from the group, take their copies along', async () => {
    const readCache = new ReadCache();
    const { federation, remote, b, link } = await readable({ readCache });
    b.hub({ topic: 'sessions', event: 'upsert', session: { id: 's2', status: 'working' } });
    await federation.read(link, 's1', '/api/sessions/s1/messages');
    await federation.read(link, 's2', '/api/sessions/s2/messages');
    b.hub({ topic: 'sessions', event: 'remove', sessionId: 's2' });
    expect(readCache.get(B, '/api/sessions/s2/messages')).toBeNull();
    expect(readCache.get(B, '/api/sessions/s1/messages')).not.toBeNull();
    remote.members = [entry(SELF), entry(B, { removedAt: 2, removedBy: SELF }), entry('member-c')];
    remote.published();
    expect(federation.link(B)).toBeNull();
    expect(readCache.get(B, '/api/sessions/s1/messages')).toBeNull();
    expect(readCache.size()).toBe(0);
  });
});

describe('ReadCache', () => {
  const sized = (n: number) => 'x'.repeat(n - 2); // its JSON carries two quotes

  it('keeps at most its bytes, the least recently used out first', () => {
    const cache = new ReadCache(300, 200);
    cache.put('m', 's', '/a', sized(100), 1);
    cache.put('m', 's', '/b', sized(100), 2);
    cache.put('m', 's', '/c', sized(100), 3);
    // /a used now: /b is the oldest.
    expect(cache.get('m', '/a')).toEqual({ body: sized(100), at: 1 });
    cache.put('m', 's', '/d', sized(100), 4);
    expect(cache.get('m', '/b')).toBeNull();
    expect(cache.get('m', '/a')).not.toBeNull();
    expect(cache.size()).toBe(300);
    // A new answer to a kept url replaces it, not adds to it.
    cache.put('m', 's', '/a', sized(50), 5);
    expect(cache.size()).toBe(250);
    expect(cache.get('m', '/c')).not.toBeNull();
  });

  it('does not keep an answer bigger than an entry may be, and drops the older copy of its url', () => {
    const cache = new ReadCache(1000, 200);
    cache.put('m', 's', '/a', sized(100), 1);
    cache.put('m', 's', '/a', sized(201), 2);
    expect(cache.get('m', '/a')).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('a copy is the answer as it was kept, whatever is done to what it gave', () => {
    const cache = new ReadCache();
    cache.put('m', 's', '/a', { list: [1] }, 1);
    (cache.get('m', '/a')!.body as { list: number[] }).list.push(2);
    expect(cache.get('m', '/a')!.body).toEqual({ list: [1] });
  });
});
