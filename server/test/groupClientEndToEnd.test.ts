/**
 * The phone as a member (`GroupClient`) against real servers on one
 * in-memory relay: joining by the primary's code, linking with the others
 * without a ceremony, a server founding a group by a phone's own code,
 * removal, leaving, and a Mac from before groups served one-to-one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { generateIdentity } from '@orbital/shared/remote/keys';
import { memberIds } from '@orbital/shared/remote/roster';
import { Channel } from '@orbital/shared/remote/channel';
import {
  GroupClient, MemoryGroupStorage, type GroupClientEvent,
} from '@orbital/shared/remote/groupClient';
import { startMacAndRelay, until, type MacAndRelay } from './remoteHarness.js';

/** On: every server's hello is a shipped Mac's, `{ protocol, server, macName }`, naming no capabilities. */
const legacy = vi.hoisted(() => ({ on: false }));
vi.mock('../src/remote/identity.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/remote/identity.js')>();
  return {
    ...real,
    serverHello: (o: Parameters<typeof real.serverHello>[0]) =>
      (legacy.on ? { server: o.serverVersion, macName: o.name } : real.serverHello(o)),
  };
});

/** `mutual`: the peer of every `/pair/mutual` the phone posted. */
type Phone = { client: GroupClient; events: GroupClientEvent[]; posts: string[]; mutual: string[]; channels: Channel[] };

describe('the phone as a member', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => {
    legacy.on = false;
    vi.restoreAllMocks();
    for (const c of closers.splice(0).reverse()) await c();
  });

  async function startPhone(relayUrl: string): Promise<Phone> {
    const posts: string[] = [];
    const mutual: string[] = [];
    const channels: Channel[] = [];
    const client = new GroupClient({
      relayUrl, identity: generateIdentity(), WebSocketImpl: WebSocket,
      app: 'orbital-mobile/test', os: 'android', name: 'Pixel', storage: new MemoryGroupStorage(), log: () => {},
      fetchImpl: (input, init) => {
        const path = new URL(input).pathname;
        posts.push(path);
        if (path === '/pair/mutual') mutual.push((JSON.parse(init.body as string) as { payload: { peer: string } }).payload.peer);
        return fetch(input, init);
      },
    });
    const events: GroupClientEvent[] = [];
    client.on((e) => {
      events.push(e);
      if (e.type === 'channel') channels.push(e.channel);
    });
    client.start();
    closers.push(() => client.stop());
    await until(() => client.status === 'online');
    return { client, events, posts, mutual, channels };
  }

  const statusOf = async (s: MacAndRelay) => (await s.api('GET', '/api/remote')).json();

  /** Two servers in one group, A ↔ B joined by a ceremony. */
  async function twoServers() {
    const a = await startMacAndRelay(closers, { name: 'studio' });
    const b = await startMacAndRelay(closers, { relayUrl: a.relayUrl, name: 'laptop' });
    const qr = (await a.api('POST', '/api/remote/pair')).json().qr;
    const join = await b.api('POST', '/api/remote/join', { code: qr });
    await until(async () => (await statusOf(a)).pendingPair !== null);
    const idA = (await statusOf(a)).macId as string;
    const idB = (await statusOf(b)).macId as string;
    await a.api('POST', '/api/remote/pair/confirm', { accept: true, phone: idB, code: join.json().code });
    await until(() => a.remote.channel(idB)?.ready === true && b.remote.channel(idA)?.ready === true);
    return { a, b, idA, idB };
  }

  /** The phone redeems `mac`'s code and the user types the phone's code there. */
  async function joinBy(phone: Phone, mac: MacAndRelay, macId: string): Promise<void> {
    const qr = (await mac.api('POST', '/api/remote/pair')).json().qr;
    const join = await phone.client.join(qr);
    if (!('code' in join)) throw new Error(`join failed: ${JSON.stringify(join)}`);
    expect(join.device).toBe(macId);
    await until(async () => (await statusOf(mac)).pendingPair !== null);
    expect((await statusOf(mac)).pendingPair).toMatchObject({ phone: phone.client.id, kind: 'phone', name: 'Pixel' });
    const confirm = await mac.api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.client.id, code: join.code });
    expect(confirm.statusCode).toBe(200);
    await until(() => phone.client.channel(macId)?.ready === true);
    expect(phone.events).toContainEqual({ type: 'joined', peer: macId });
  }

  /** A, B and a phone that joined A and linked with B by itself. */
  async function phoneInGroup() {
    const servers = await twoServers();
    const phone = await startPhone(servers.a.relayUrl);
    await joinBy(phone, servers.a, servers.idA);
    await until(() => phone.client.channel(servers.idB)?.ready === true, 15_000);
    return { ...servers, phone };
  }

  const isMember = (s: MacAndRelay, id: string) => memberIds(s.remote.rosterState()).includes(id);
  const pairedWith = async (s: MacAndRelay, id: string) => (await statusOf(s)).devices.some((d: any) => d.id === id);

  it('joins one member by its code and links with the other without a ceremony', async () => {
    const { a, b, idA, idB, phone } = await phoneInGroup();
    expect((await phone.client.channel(idA)!.request('GET', '/api/health')).status).toBe(200);
    expect((await phone.client.channel(idB)!.request('GET', '/api/health')).status).toBe(200);
    // Every member lists all three, linked; the phone links like any member.
    await until(() => a.remote.rosterDigest() === b.remote.rosterDigest()
      && phone.client.members().length === 3 && phone.client.members().every((m) => m.self || m.linked));
    expect(phone.client.members().find((m) => m.self)).toMatchObject({ kind: 'phone', links: true, name: 'Pixel', os: 'android' });
    expect((await statusOf(b)).group.members.find((m: any) => m.id === phone.client.id)).toMatchObject({
      kind: 'phone', links: true, linked: true,
    });
    expect(phone.client.peers().map((p) => p.id).sort()).toEqual([idA, idB].sort());
    expect(phone.client.inGroup()).toBe(true);
    // B joined A by its code while both were alone: A, showing the code, founded the group and
    // is its primary. Every member says so, and the phone is no primary.
    for (const status of [await statusOf(a), await statusOf(b)]) expect(status.group.primary).toMatchObject({ id: idA, name: 'studio' });
    expect(phone.client.primary()).toEqual({ id: idA, name: 'studio' });
    expect(phone.client.members().filter((m) => m.primary).map((m) => m.id)).toEqual([idA]);
    // The phone, not the primary, neither shows a code nor removes a member.
    expect(await phone.client.startPairing()).toEqual({ error: 'not_primary', primary: { id: idA, name: 'studio' } });
    expect(await phone.client.remove(idB)).toEqual({ error: 'not_primary', primary: { id: idA, name: 'studio' } });
  }, 30_000);

  it('a phone whose stored roster was dropped learns it again from its members', async () => {
    const { a, idA, idB } = await twoServers();
    const identity = generateIdentity();
    const storage = new MemoryGroupStorage();
    const make = (store: MemoryGroupStorage) => new GroupClient({
      relayUrl: a.relayUrl, identity, WebSocketImpl: WebSocket, app: 'orbital-mobile/test', os: 'android', name: 'Pixel',
      storage: store, log: () => {},
    });
    const first = make(storage);
    const events: GroupClientEvent[] = [];
    first.on((e) => { events.push(e); });
    first.start();
    closers.push(() => first.stop());
    await until(() => first.status === 'online');
    await joinBy({ client: first, events, posts: [], mutual: [], channels: [] }, a, idA);
    await until(() => first.channel(idB)?.ready === true && first.members().length === 3, 15_000);
    first.stop();
    // A roster that no longer reads (one stored before the primary signed it): dropped, the pairs kept.
    const stored = storage.toJSON();
    const dropped = MemoryGroupStorage.fromJSON({ ...stored, roster: [{ id: idA, epoch: 1 }] });
    expect(dropped.roster.read().roster).toBeNull();
    expect(dropped.paired.list().map((d) => d.id).sort()).toEqual([idA, idB].sort());
    const again = make(dropped);
    again.start();
    closers.push(() => again.stop());
    await until(() => again.members().length === 3 && again.members().every((m) => m.self || m.linked), 15_000);
    expect(again.members().find((m) => m.self)).toMatchObject({ primary: false, name: 'Pixel' });
    expect(again.primary()).toEqual({ id: idA, name: 'studio' });
  }, 30_000);

  it('a phone alone shows its code: the server that types it founds the group, and adds the next device', async () => {
    const c = await startMacAndRelay(closers, { name: 'vps' });
    const idC = (await statusOf(c)).macId as string;
    const phone = await startPhone(c.relayUrl);
    const shown = await phone.client.startPairing();
    if (!('qr' in shown)) throw new Error(`no code: ${JSON.stringify(shown)}`);
    expect(phone.client.pairing).not.toBeNull();
    const join = await c.api('POST', '/api/remote/join', { code: shown.qr });
    expect(join.statusCode).toBe(200);
    await until(() => phone.client.pendingPair !== null);
    expect(phone.events.some((e) => e.type === 'pair_request' && e.phone === idC)).toBe(true);
    expect(phone.client.pendingPair).toMatchObject({ phone: idC, name: 'vps', kind: 'desktop' });
    expect(await phone.client.confirmPairing(true, idC, join.json().code)).toEqual({ ok: true });
    await until(() => phone.client.channel(idC)?.ready === true && phone.client.primary()?.id === idC, 15_000);
    expect((await statusOf(c)).group).toMatchObject({ isPrimary: true });
    expect((await phone.client.channel(idC)!.request('GET', '/api/health')).status).toBe(200);
    // A fourth device joins through the primary, and links with the phone without a ceremony.
    const a = await startMacAndRelay(closers, { relayUrl: c.relayUrl, name: 'studio' });
    const idA = (await statusOf(a)).macId as string;
    const qr = (await c.api('POST', '/api/remote/pair')).json().qr;
    const joinA = await a.api('POST', '/api/remote/join', { code: qr });
    await until(async () => (await statusOf(c)).pendingPair !== null);
    await c.api('POST', '/api/remote/pair/confirm', { accept: true, phone: idA, code: joinA.json().code });
    await until(() => phone.client.channel(idA)?.ready === true && a.remote.channel(phone.client.id)?.ready === true, 15_000);
    expect((await phone.client.channel(idA)!.request('GET', '/api/health')).status).toBe(200);
  }, 30_000);

  it('two phones of one group never link with each other, and each reads the other as paired with the desktop', async () => {
    const a = await startMacAndRelay(closers, { name: 'studio' });
    const idA = (await statusOf(a)).macId as string;
    const one = await startPhone(a.relayUrl);
    await joinBy(one, a, idA);
    const two = await startPhone(a.relayUrl);
    await joinBy(two, a, idA);
    // Both phones hear of each other through A's roster.
    await until(() => one.client.members().length === 3 && two.client.members().length === 3);
    // A reconnect asks every member again: still not the other phone.
    one.client.stop();
    one.client.start();
    await until(() => one.client.status === 'online');
    await until(() => one.client.channel(idA)?.ready === true);
    for (const [phone, other] of [[one, two], [two, one]] as const) {
      expect(phone.mutual).not.toContain(other.client.id);
      expect(phone.client.peers().map((p) => p.id)).toEqual([idA]);
      expect(phone.events.some((e) => e.type === 'channel' && e.peer === other.client.id)).toBe(false);
      expect(phone.client.members().find((m) => m.id === other.client.id)).toMatchObject({
        kind: 'phone', links: true, linked: false,
      });
      expect(phone.client.members().find((m) => m.id === other.client.id)?.state).not.toBe('linking');
    }
    // The desktop links with both, as it always did.
    expect((await statusOf(a)).devices.map((d: any) => d.id).sort()).toEqual([one.client.id, two.client.id].sort());
  }, 30_000);

  it('removing the phone on the primary removes it everywhere', async () => {
    const { a, b, idA, idB, phone } = await phoneInGroup();
    const id = phone.client.id;
    expect((await b.api('DELETE', `/api/remote/devices/${id}`)).statusCode).toBe(403);
    expect((await a.api('DELETE', `/api/remote/devices/${id}`)).statusCode).toBe(200);
    await until(() => phone.client.channel(idA) === null && phone.client.channel(idB) === null
      && phone.client.peers().length === 0, 15_000);
    // Alone: it holds no roster.
    expect(phone.client.members()).toEqual([expect.objectContaining({ id, self: true })]);
    expect(phone.client.primary()).toBeNull();
    expect(phone.client.inGroup()).toBe(false);
    await until(async () => !(await pairedWith(a, id)) && !(await pairedWith(b, id)) && !isMember(b, id), 15_000);
    expect(phone.events.filter((e) => e.type === 'unpaired_all')).toHaveLength(1);
  }, 30_000);

  it('the phone leaves: the servers drop it', async () => {
    const { a, b, idA, idB, phone } = await phoneInGroup();
    const id = phone.client.id;
    expect(await phone.client.leave()).toEqual({ ok: true });
    await until(async () => {
      for (const s of [a, b]) {
        if (isMember(s, id) || (await pairedWith(s, id))) return false;
      }
      return a.remote.channel(id) === null && b.remote.channel(id) === null;
    }, 15_000);
    expect(phone.client.channel(idA)).toBeNull();
    expect(phone.client.channel(idB)).toBeNull();
    expect(phone.client.members()).toEqual([expect.objectContaining({ id, self: true })]);
    // Its own choice: not the "removed" screen.
    expect(phone.events.some((e) => e.type === 'unpaired_all')).toBe(false);
  }, 30_000);

  it('a Mac from before groups is served one-to-one: no roster message, no mutual pair', async () => {
    legacy.on = true;
    const sendGroup = vi.spyOn(Channel.prototype, 'sendGroup');
    const mac = await startMacAndRelay(closers, { name: 'old' });
    const idMac = (await statusOf(mac)).macId as string;
    let heard = 0;
    mac.remote.onChannel((_id, channel) => channel.on((e) => { if (e.type === 'group') heard++; }));
    const phone = await startPhone(mac.relayUrl);
    await joinBy(phone, mac, idMac);
    const channel = phone.client.channel(idMac)!;
    expect(channel.peer).toEqual({ t: 'hello', protocol: 1, server: expect.any(String), macName: 'old' });
    expect(channel.groups).toBe(false);
    expect((await channel.request('GET', '/api/health')).status).toBe(200);
    // Long enough for a roster exchange or a mutual ask, had either happened.
    await new Promise((r) => setTimeout(r, 500));
    const sentByPhone = sendGroup.mock.contexts
      .map((ctx, i) => [ctx, sendGroup.mock.results[i]?.value] as const)
      .filter(([ctx, sent]) => phone.channels.includes(ctx as Channel) && sent === true);
    expect(sentByPhone).toEqual([]);
    expect(heard).toBe(0);
    expect(phone.posts).not.toContain('/pair/mutual');
    // It sends no roster, and a phone adds no one: the phone serves it as a pair of its own.
    expect(phone.client.members().find((m) => m.id === idMac)).toBeUndefined();
    expect(phone.client.peers()).toEqual([expect.objectContaining({ id: idMac, name: 'old' })]);
  }, 30_000);
});
