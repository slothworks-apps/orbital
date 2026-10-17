import { afterEach, describe, expect, it } from 'vitest';
import { deviceId, generateIdentity, type Identity } from '../src/remote/keys.js';
import { ZERO_WAKE, decodeFrame, encodeFrame } from '../src/remote/frame.js';
import { Channel } from '../src/remote/channel.js';
import type { RelayToDevice } from '../src/remote/relayApi.js';
import type { SocketLike } from '../src/remote/relayLink.js';
import { MIN_RELAY_VERSION } from '../src/remote/version.js';
import { GroupClient, MemoryGroupStorage, type GroupClientEvent } from '../src/remote/groupClient.js';

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

function setup(seed: (storage: MemoryGroupStorage) => void = () => {}, opts: { silenceTimeoutMs?: number; handshakeTimeoutMs?: number } = {}) {
  FakeSocket.all = [];
  const identity = generateIdentity();
  const storage = new MemoryGroupStorage();
  seed(storage);
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

function online(sock: FakeSocket, ok: { peers: string[]; pairs?: string[] }): void {
  sock.control({ type: 'challenge', nonce: 'n', version: MIN_RELAY_VERSION });
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
});

describe('GroupClient', () => {
  it('adds itself to its roster as a phone that links', () => {
    const s = setup();
    expect(s.client.members()).toEqual([expect.objectContaining({ id: s.client.id, kind: 'phone', links: true, self: true })]);
    expect(s.stored()).toBeGreaterThan(0);
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
    // A goes quiet: its channel is dropped and opened again; the socket and B's channel stay.
    a.hears = false;
    await until(() => s.client.channel(a.id) !== first);
    a.hears = true;
    await until(() => s.client.channel(a.id)?.ready === true);
    expect(FakeSocket.all).toHaveLength(1);
    expect(s.client.channel(b.id)).toBe(toB);
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
    storage.roster.replace([{
      id, kind: 'desktop', name: 'studio', os: 'macos', links: true, epoch: 1, addedBy: id, addedAt: 1, describedAt: 1,
    }]);
    const back = MemoryGroupStorage.fromJSON(JSON.parse(JSON.stringify(storage)));
    expect(back.toJSON()).toEqual(storage.toJSON());
    expect(back.roster.digest()).toBe(storage.roster.digest());
  });

  it('reads garbage as empty, and keeps the rows that read', () => {
    for (const garbage of [null, 'x', 42, [], { roster: 'no', paired: {}, pendingRevokes: [1] }]) {
      expect(MemoryGroupStorage.fromJSON(garbage).toJSON()).toEqual({ roster: [], paired: [], pendingRevokes: [] });
    }
    const id = idOf();
    const mixed = MemoryGroupStorage.fromJSON({
      paired: [{ id, name: 'studio', platform: 'darwin', kind: null, pairedAt: 1, lastSeenAt: null }, { id: 'nope' }],
      pendingRevokes: [id, 'not a device'],
    });
    expect(mixed.paired.list().map((d) => d.id)).toEqual([id]);
    expect(mixed.pendingRevokes.list()).toEqual([id]);
  });
});
