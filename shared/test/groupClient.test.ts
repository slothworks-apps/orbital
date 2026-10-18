import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceId, generateIdentity, type Identity } from '../src/remote/keys.js';
import { ZERO_WAKE, decodeFrame, encodeFrame } from '../src/remote/frame.js';
import { Channel } from '../src/remote/channel.js';
import type { RelayToDevice } from '../src/remote/relayApi.js';
import type { SocketLike } from '../src/remote/relayLink.js';
import { RELAY_PHONE_GROUP_VERSION, RELAY_VERSION_HEADER } from '../src/remote/version.js';
import { ALONE_GRACE_MS, GroupClient, MemoryGroupStorage, type GroupClientEvent } from '../src/remote/groupClient.js';
import { describeDevice, foundRoster, memberIds, type RosterState } from '../src/remote/roster.js';

/** The relay socket the test plays: frames the phone sends go to `route`, a microtask later. */
class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  static route: (frame: Uint8Array) => void = () => {};
  binaryType = 'blob';
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') return;
    const bytes = new Uint8Array(data);
    queueMicrotask(() => FakeSocket.route(bytes));
  }

  close(): void {
    this.closed = true;
  }

  control(msg: RelayToDevice): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  binary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.slice().buffer });
  }
}

/** A member at the other end: a responder channel, fed what the phone sends it, answering through the socket. */
class Peer {
  readonly identity: Identity = generateIdentity();
  readonly id = deviceId(this.identity.publicKey);
  channel: Channel | null = null;
  /** False: frames to this peer are lost, as from a member that went quiet. */
  hears = true;

  constructor(private readonly phone: Identity, private readonly sock: () => FakeSocket, private readonly serves: boolean) {}

  receive(body: Uint8Array): void {
    if (!this.hears) return;
    // A keyed channel takes the phone's fresh handshake itself (`rehandshake`).
    this.channel ??= this.make();
    this.channel.receive(body);
  }

  private make(): Channel {
    return new Channel({
      identity: this.identity, peerKey: this.phone.publicKey, role: 'responder',
      hello: this.serves
        ? { server: '1', macName: 'studio', kind: 'desktop', capabilities: ['sessions', 'group'] }
        : { kind: 'desktop', capabilities: ['group'] },
      send: (body) => this.sock().binary(encodeFrame({ peer: this.identity.publicKey, flags: 0, wake: ZERO_WAKE, body })),
    });
  }
}

type SetupOpts = {
  silenceTimeoutMs?: number; handshakeTimeoutMs?: number; reconnectDelayMs?: number; now?: () => number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
};

function setup(seed: (storage: MemoryGroupStorage, self: string) => void = () => {}, opts: SetupOpts = {}) {
  FakeSocket.all = [];
  const identity = generateIdentity();
  const storage = new MemoryGroupStorage();
  seed(storage, deviceId(identity.publicKey));
  let stored = 0;
  const client = new GroupClient({
    relayUrl: 'https://relay.test', identity, WebSocketImpl: FakeSocket, app: 'orbital-mobile/test', os: 'android',
    name: 'Pixel', storage, onStored: () => { stored++; }, log: () => {},
    // Nothing answers a post: the group's mutual asks and revokes go nowhere.
    fetchImpl: () => Promise.reject(new Error('offline')),
    ...opts,
  });
  const events: GroupClientEvent[] = [];
  client.on((e) => events.push(e));
  client.start();
  const sock = () => FakeSocket.all[FakeSocket.all.length - 1];
  return { identity, storage, client, events, sock, stored: () => stored };
}

function online(sock: FakeSocket, ok: { peers: string[]; pairs?: string[] }, version = RELAY_PHONE_GROUP_VERSION): void {
  sock.control({ type: 'challenge', nonce: 'n', version });
  sock.control({ type: 'ok', ...ok });
}

function pairWith(storage: MemoryGroupStorage, id: string, name = 'studio'): void {
  storage.paired.add({ id, name, platform: 'darwin', kind: 'desktop', pairedAt: 1 });
}

const idOf = () => deviceId(generateIdentity().publicKey);

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

afterEach(() => {
  FakeSocket.route = () => {};
  vi.useRealTimers();
});

/**
 * A group whose primary (a fresh desktop) names `id`, a desktop that links,
 * and the phone `self`.
 */
function member(id: string, self: string): RosterState {
  const primary = generateIdentity();
  const doc = foundRoster(primary, 'desktop', [{ id, kind: 'desktop' }, { id: self, kind: 'phone' }], 1)!;
  return {
    roster: doc,
    descriptions: [
      describeDevice(deviceId(primary.publicKey), { name: 'primary', os: 'macos', links: true }, primary, 1),
      describeDevice(id, { name: 'vps', os: 'linux', links: true }, primary, 1),
    ],
    left: [],
  };
}

/** A member that links, in the roster of a phone that is in its group. */
function grouped(storage: MemoryGroupStorage, id: string, self: string): void {
  storage.roster.replace(member(id, self));
}

describe('GroupClient', () => {
  it('alone, it holds no roster and lists itself as a phone that links; in a group, it describes itself', () => {
    const s = setup();
    expect(s.client.members()).toEqual([expect.objectContaining({ id: s.client.id, kind: 'phone', links: true, self: true })]);
    expect(s.storage.roster.read().roster).toBeNull();
    expect(s.client.primary()).toBeNull();
    const g = setup((storage, self) => grouped(storage, idOf(), self));
    const state = g.storage.roster.read();
    expect(memberIds(state)).toContain(g.client.id);
    expect(state.descriptions.find((d) => d.id === g.client.id)).toMatchObject({ by: g.client.id, name: 'Pixel', links: true });
    expect(g.client.primary()).toMatchObject({ name: 'primary' });
    expect(g.client.isPrimary()).toBe(false);
  });

  it('opens a channel to every paired member online, and a silent one starts over alone', async () => {
    // The handshake retries soon: the first one after the silence is lost with A's frames.
    const s = setup(() => {}, { silenceTimeoutMs: 150, handshakeTimeoutMs: 100 });
    // A serves, so its silence counts; B only takes roster messages.
    const a = new Peer(s.identity, s.sock, true);
    const b = new Peer(s.identity, s.sock, false);
    const peers = [a, b];
    pairWith(s.storage, a.id);
    pairWith(s.storage, b.id, 'vps');
    FakeSocket.route = (bytes) => {
      const frame = decodeFrame(bytes);
      if (!frame) return;
      peers.find((p) => p.id === deviceId(frame.peer))?.receive(frame.body);
    };
    online(s.sock(), { peers: [a.id, b.id], pairs: [a.id, b.id] });
    await until(() => s.client.channel(a.id)?.ready === true && s.client.channel(b.id)?.ready === true);
    const first = s.client.channel(a.id);
    const toB = s.client.channel(b.id);
    expect(s.client.peers().map((p) => [p.id, p.online, p.ready])).toEqual([[a.id, true, true], [b.id, true, true]]);
    // A goes quiet while B still talks (its wakes): A's channel is dropped and opened again; the socket and B's channel stay.
    const talking = setInterval(() => {
      s.sock().binary(encodeFrame({ peer: b.identity.publicKey, flags: 0, wake: ZERO_WAKE, body: new Uint8Array(0) }));
    }, 20);
    try {
      a.hears = false;
      await until(() => s.client.channel(a.id) !== first);
      a.hears = true;
      await until(() => s.client.channel(a.id)?.ready === true);
    } finally {
      clearInterval(talking);
    }
    expect(FakeSocket.all).toHaveLength(1);
    expect(s.client.channel(b.id)).toBe(toB);
  });

  it('every channel silent: the socket is rebuilt and every channel handshakes again on the new one', async () => {
    const s = setup(() => {}, { silenceTimeoutMs: 150, handshakeTimeoutMs: 100, reconnectDelayMs: 10 });
    const a = new Peer(s.identity, s.sock, true);
    const b = new Peer(s.identity, s.sock, true);
    const peers = [a, b];
    pairWith(s.storage, a.id);
    pairWith(s.storage, b.id, 'vps');
    FakeSocket.route = (bytes) => {
      const frame = decodeFrame(bytes);
      if (!frame) return;
      peers.find((p) => p.id === deviceId(frame.peer))?.receive(frame.body);
    };
    online(s.sock(), { peers: [a.id, b.id], pairs: [a.id, b.id] });
    await until(() => s.client.channel(a.id)?.ready === true && s.client.channel(b.id)?.ready === true);
    const first = s.sock();
    // A half-open socket: nothing gets through either way.
    a.hears = false;
    b.hears = false;
    await until(() => FakeSocket.all.length === 2);
    expect(first.closed).toBe(true);
    a.hears = true;
    b.hears = true;
    a.channel = null;
    b.channel = null;
    online(s.sock(), { peers: [a.id, b.id], pairs: [a.id, b.id] });
    await until(() => s.client.channel(a.id)?.ready === true && s.client.channel(b.id)?.ready === true);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('no pair at the relay and none formed within ALONE_GRACE_MS: unreachable, and nothing forgotten', () => {
    vi.useFakeTimers();
    const b = idOf();
    const s = setup((storage, self) => {
      pairWith(storage, b);
      grouped(storage, b, self);
    });
    online(s.sock(), { peers: [], pairs: [] });
    expect(s.events.map((e) => e.type)).toContain('pairs_lost');
    vi.advanceTimersByTime(ALONE_GRACE_MS - 1);
    expect(s.client.unreachable).toBe(false);
    vi.advanceTimersByTime(1);
    expect(s.client.unreachable).toBe(true);
    expect(s.events.filter((e) => e.type === 'unreachable')).toEqual([{ type: 'unreachable', unreachable: true }]);
    // A relay reset while every member sleeps: the phone keeps its group and its key.
    expect(s.events.some((e) => e.type === 'unpaired_all')).toBe(false);
    expect(s.client.members().map((m) => m.id)).toContain(b);
    // Said once while it lasts.
    s.sock().control({ type: 'ok', peers: [], pairs: [] });
    vi.advanceTimersByTime(ALONE_GRACE_MS);
    expect(s.events.filter((e) => e.type === 'unreachable')).toHaveLength(1);
    // A pair forming clears it.
    s.sock().control({ type: 'linked', peer: b });
    expect(s.client.unreachable).toBe(false);
    expect(s.events.filter((e) => e.type === 'unreachable').at(-1)).toEqual({ type: 'unreachable', unreachable: false });
  });

  it('an ok that names a pair again clears unreachable', () => {
    vi.useFakeTimers();
    const b = idOf();
    const s = setup((storage, self) => grouped(storage, b, self));
    online(s.sock(), { peers: [], pairs: [] });
    vi.advanceTimersByTime(ALONE_GRACE_MS);
    expect(s.client.unreachable).toBe(true);
    // A reconnect to a relay that holds the pair again (formed while this socket was down).
    s.sock().control({ type: 'ok', peers: [], pairs: [b] });
    expect(s.client.unreachable).toBe(false);
    expect(s.events.filter((e) => e.type === 'unreachable').at(-1)).toEqual({ type: 'unreachable', unreachable: false });
  });

  it('a pair that forms within ALONE_GRACE_MS (a relay that lost its pairs) keeps the phone reachable', () => {
    vi.useFakeTimers();
    const b = idOf();
    const s = setup((storage, self) => grouped(storage, b, self));
    online(s.sock(), { peers: [], pairs: [] });
    vi.advanceTimersByTime(ALONE_GRACE_MS / 2);
    s.sock().control({ type: 'linked', peer: b });
    vi.advanceTimersByTime(ALONE_GRACE_MS);
    expect(s.events.some((e) => e.type === 'unreachable')).toBe(false);
    expect(s.client.peers().map((p) => p.id)).toEqual([b]);
  });

  it('a relay that names no pairs, or a phone in no group, never waits to be alone', () => {
    vi.useFakeTimers();
    const old = setup((storage, self) => grouped(storage, idOf(), self));
    online(old.sock(), { peers: [] });
    const alone = setup();
    online(alone.sock(), { peers: [], pairs: [] });
    vi.advanceTimersByTime(ALONE_GRACE_MS * 2);
    expect([...old.events, ...alone.events].some((e) => e.type === 'unreachable' || e.type === 'unpaired_all')).toBe(false);
  });

  it('a relay too old to answer the web view: members pair by hand, and no code is shown', async () => {
    const b = idOf();
    // A web view's CORS failure: fetch throws.
    const s = setup((storage, self) => grouped(storage, b, self), { fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) });
    online(s.sock(), { peers: [] }, '0.5.0');
    await until(() => s.client.members().find((m) => m.id === b)?.state === 'notLinked');
    expect(await s.client.startPairing()).toEqual({ error: 'relay_too_old' });
    // The same failure on a relay new enough is the network's: asked again, no code.
    const fresh = setup((storage, self) => grouped(storage, b, self), { fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) });
    online(fresh.sock(), { peers: [] });
    // A member that is not the primary shows no code: only the primary adds a device.
    expect(await fresh.client.startPairing()).toMatchObject({ error: 'not_primary', primary: { name: 'primary' } });
    expect(fresh.client.members().find((m) => m.id === b)?.state).toBe('linking');
  });

  it('never opens a channel to another phone, even one a phone from before the rule paired', () => {
    const other = idOf();
    const desktop = idOf();
    const s = setup((storage) => {
      pairWith(storage, desktop);
      storage.paired.add({ id: other, name: 'pixel', platform: 'android', kind: 'phone', pairedAt: 1 });
    });
    const sent: string[] = [];
    FakeSocket.route = (bytes) => {
      const frame = decodeFrame(bytes);
      if (frame) sent.push(deviceId(frame.peer));
    };
    online(s.sock(), { peers: [desktop, other], pairs: [desktop, other] });
    s.sock().control({ type: 'presence', peer: other, online: true });
    expect(s.client.channel(desktop)).not.toBeNull();
    expect(s.client.channel(other)).toBeNull();
  });

  it('says group when its code runs out, and the code and the request made with it are gone', async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const expiresAt = now + 60_000;
    const s = setup(() => {}, {
      now: () => now,
      fetchImpl: async () => new Response(JSON.stringify({ token: 't', expiresAt }), {
        status: 200, headers: { [RELAY_VERSION_HEADER]: RELAY_PHONE_GROUP_VERSION },
      }),
    });
    online(s.sock(), { peers: [] });
    expect(await s.client.startPairing()).toMatchObject({ expiresAt });
    expect(s.client.pairing).toEqual({ expiresAt });
    const before = s.events.filter((e) => e.type === 'group').length;
    now = expiresAt - 1;
    vi.advanceTimersByTime(59_999);
    expect(s.events.filter((e) => e.type === 'group')).toHaveLength(before);
    now = expiresAt;
    vi.advanceTimersByTime(1);
    expect(s.events.filter((e) => e.type === 'group')).toHaveLength(before + 1);
    expect(s.client.pairing).toBeNull();
    s.client.stop();
  });

  it('the socket anchors on the first paired device there is; a new one takes over at the next connect', () => {
    const [a, b] = [idOf(), idOf()];
    const s = setup((storage) => {
      pairWith(storage, a);
      pairWith(storage, b);
    });
    online(s.sock(), { peers: [] });
    s.sock().control({ type: 'unpaired', mac: a });
    s.client.stop();
    s.client.start();
    const url = new URL(s.sock().url);
    expect([url.searchParams.get('mac'), url.searchParams.get('paired')]).toEqual([b, '1']);
  });

  it('ok naming every pair drops a pair the relay no longer holds; none left is unpaired_all, once', () => {
    const [a, b] = [idOf(), idOf()];
    const s = setup((storage) => {
      pairWith(storage, a);
      pairWith(storage, b);
    });
    online(s.sock(), { peers: [], pairs: [a] });
    expect(s.client.peers().map((p) => p.id)).toEqual([a]);
    expect(s.events.filter((e) => e.type === 'unpaired_all')).toHaveLength(0);
    s.sock().control({ type: 'ok', peers: [], pairs: [] });
    expect(s.client.peers()).toEqual([]);
    s.sock().control({ type: 'ok', peers: [], pairs: [] });
    expect(s.events.filter((e) => e.type === 'unpaired_all')).toHaveLength(1);
  });

  it('a relay that lost every pair of a phone still in its group: pairs_lost, not unpaired_all', () => {
    const [a, b] = [idOf(), idOf()];
    const s = setup((storage, self) => {
      pairWith(storage, a);
      pairWith(storage, b);
      // B links: the group is intact, and its members pair again through /pair/mutual.
      storage.roster.replace(member(b, self));
    });
    online(s.sock(), { peers: [], pairs: [] });
    expect(s.client.peers()).toEqual([]);
    expect(s.events.map((e) => e.type)).toContain('pairs_lost');
    expect(s.events.some((e) => e.type === 'unpaired_all')).toBe(false);
  });

  it('a pair added after the last ok is not dropped by the next ok; the one after decides', () => {
    let now = 100;
    const [a, c] = [idOf(), idOf()];
    const s = setup((storage) => pairWith(storage, a), { now: () => now });
    online(s.sock(), { peers: [], pairs: [a] });
    // A confirm writes its row before the relay records the pair; the socket reconnects in between.
    now = 150;
    s.storage.paired.add({ id: c, name: 'vps', platform: 'linux', kind: 'headless', pairedAt: now });
    now = 200;
    s.sock().control({ type: 'ok', peers: [], pairs: [a] });
    expect(s.client.peers().map((p) => p.id).sort()).toEqual([a, c].sort());
    now = 300;
    s.sock().control({ type: 'ok', peers: [], pairs: [a] });
    expect(s.client.peers().map((p) => p.id)).toEqual([a]);
    expect(s.events.some((e) => e.type === 'unpaired_all')).toBe(false);
  });

  it('a relay without pairs: the socket anchors on the first paired device, and unpaired drops that pair', () => {
    const [a, b] = [idOf(), idOf()];
    const s = setup((storage) => {
      pairWith(storage, a);
      pairWith(storage, b);
    });
    const url = new URL(s.sock().url);
    expect([url.searchParams.get('mac'), url.searchParams.get('paired')]).toEqual([a, '1']);
    online(s.sock(), { peers: [] });
    expect(s.client.peers()).toHaveLength(2);
    s.sock().control({ type: 'unpaired', mac: a });
    expect(s.client.peers().map((p) => p.id)).toEqual([b]);
    s.sock().control({ type: 'unpaired', mac: b });
    expect(s.events.filter((e) => e.type === 'unpaired_all')).toHaveLength(1);
  });

  it('drops and counts a frame or a wake from a device that is not paired', () => {
    const s = setup();
    online(s.sock(), { peers: [] });
    const stranger = generateIdentity().publicKey;
    s.sock().binary(encodeFrame({ peer: stranger, flags: 0, wake: ZERO_WAKE, body: new Uint8Array([1]) }));
    s.sock().binary(encodeFrame({ peer: stranger, flags: 1, wake: ZERO_WAKE, body: new Uint8Array(0) }));
    expect(s.client.dropped).toBe(2);
    expect(s.events.some((e) => e.type === 'wake')).toBe(false);
  });
});

describe('MemoryGroupStorage', () => {
  it('comes back from its JSON', () => {
    const storage = new MemoryGroupStorage();
    const id = idOf();
    storage.paired.add({ id, name: 'studio', platform: 'darwin', kind: 'desktop', pairedAt: 5 });
    storage.pendingRevokes.add(id);
    storage.roster.replace(member(id, idOf()));
    storage.groupId.set(id);
    const back = MemoryGroupStorage.fromJSON(JSON.parse(JSON.stringify(storage)));
    expect(back.toJSON()).toEqual(storage.toJSON());
    expect(back.groupId.get()).toBe(id);
    expect(back.roster.digest()).toBe(storage.roster.digest());
  });

  it('drops a roster stored before the primary signed it, and keeps the pairs', () => {
    const id = idOf();
    const unsigned = { id, kind: 'desktop', name: 'studio', os: 'macos', links: true, epoch: 1, addedBy: idOf(), addedAt: 1, describedAt: 1 };
    const back = MemoryGroupStorage.fromJSON({
      roster: [unsigned], paired: [{ id, name: 'studio', platform: 'darwin', kind: 'desktop', pairedAt: 1, lastSeenAt: null }],
    });
    expect(back.roster.read()).toEqual({ roster: null, descriptions: [], left: [] });
    // The group id is kept apart, and reads on its own.
    expect(MemoryGroupStorage.fromJSON({ roster: [unsigned], group: id }).groupId.get()).toBe(id);
    expect(MemoryGroupStorage.fromJSON({ group: 'not a key' }).groupId.get()).toBeNull();
    expect(back.paired.list().map((d) => d.id)).toEqual([id]);
  });

  it('reads garbage as empty, and keeps the rows that read', () => {
    for (const garbage of [null, 'x', 42, [], { roster: 'no', paired: {}, pendingRevokes: [1] }]) {
      expect(MemoryGroupStorage.fromJSON(garbage).toJSON()).toEqual({
        roster: { roster: null, descriptions: [], left: [] }, paired: [], pendingRevokes: [],
      });
    }
    const id = idOf();
    const mixed = MemoryGroupStorage.fromJSON({
      paired: [{ id, name: 'studio', platform: 'darwin', kind: null, pairedAt: 1, lastSeenAt: null }, { id: 'nope' }],
      pendingRevokes: [id, 'not a device'],
    });
    expect(mixed.paired.list().map((d) => d.id)).toEqual([id]);
    expect(mixed.pendingRevokes.list()).toEqual([id]);
    // A row stored without when it was last seen keeps its pair.
    const older = MemoryGroupStorage.fromJSON({ paired: [{ id, name: 'studio', platform: 'darwin', kind: 'desktop', pairedAt: 1 }] });
    expect(older.paired.get(id)).toMatchObject({ id, lastSeenAt: null });
  });
});
