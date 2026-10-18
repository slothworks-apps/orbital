/**
 * The phone as a member (`GroupClient`) against real servers on one
 * in-memory relay: joining by a member's code, linking with the others
 * without a ceremony, adding a server by the phone's own code, removal,
 * leaving, and a Mac from before groups served one-to-one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { generateIdentity } from '@orbital/shared/remote/keys';
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

  const entryIn = (s: MacAndRelay, id: string) => s.remote.rosterEntries().find((e) => e.id === id);
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
    // B joined A by its code while A was alone: A added B, and B added A, since no device adds
    // itself. The phone joined A later: A added it. Every member says who did.
    await until(() => phone.client.members().find((m) => m.id === idA)?.addedBy === idB);
    for (const roster of [a.remote.rosterEntries(), b.remote.rosterEntries(), phone.client.members()]) {
      expect(roster.find((e) => e.id === idA)?.addedBy).toBe(idB);
      expect(roster.find((e) => e.id === idB)?.addedBy).toBe(idA);
      expect(roster.find((e) => e.id === phone.client.id)?.addedBy).toBe(idA);
    }
  }, 30_000);

  it('adds a server by its own code; the server then links with the phone\'s other members', async () => {
    const a = await startMacAndRelay(closers, { name: 'studio' });
    const idA = (await statusOf(a)).macId as string;
    const phone = await startPhone(a.relayUrl);
    await joinBy(phone, a, idA);
    const c = await startMacAndRelay(closers, { relayUrl: a.relayUrl, name: 'vps' });
    const idC = (await statusOf(c)).macId as string;
    const shown = await phone.client.startPairing();
    if (!('qr' in shown)) throw new Error(`no code: ${JSON.stringify(shown)}`);
    expect(phone.client.pairing).not.toBeNull();
    const join = await c.api('POST', '/api/remote/join', { code: shown.qr });
    expect(join.statusCode).toBe(200);
    await until(() => phone.client.pendingPair !== null);
    expect(phone.events.some((e) => e.type === 'pair_request' && e.phone === idC)).toBe(true);
    expect(phone.client.pendingPair).toMatchObject({ phone: idC, name: 'vps', kind: 'desktop' });
    expect(await phone.client.confirmPairing(true, idC, join.json().code)).toEqual({ ok: true });
    await until(() => phone.client.channel(idC)?.ready === true
      && a.remote.channel(idC)?.ready === true && c.remote.channel(idA)?.ready === true, 15_000);
    expect((await phone.client.channel(idC)!.request('GET', '/api/health')).status).toBe(200);
    expect((await a.remote.channel(idC)!.request('GET', '/api/health')).status).toBe(200);
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

  it('removing the phone on B removes it everywhere', async () => {
    const { a, b, idA, idB, phone } = await phoneInGroup();
    const id = phone.client.id;
    expect((await b.api('DELETE', `/api/remote/devices/${id}`)).statusCode).toBe(200);
    await until(() => phone.client.channel(idA) === null && phone.client.channel(idB) === null
      && phone.client.peers().length === 0, 15_000);
    // A group of one: its founding entry.
    const members = phone.client.members();
    expect(members).toEqual([expect.objectContaining({ id, self: true, epoch: 0, addedBy: id })]);
    expect(phone.client.inGroup()).toBe(false);
    await until(async () => !(await pairedWith(a, id)) && !(await pairedWith(b, id))
      && entryIn(a, id)?.removedAt !== undefined, 15_000);
    expect(phone.events.filter((e) => e.type === 'unpaired_all')).toHaveLength(1);
  }, 30_000);

  it('the phone leaves: the servers drop it', async () => {
    const { a, b, idA, idB, phone } = await phoneInGroup();
    const id = phone.client.id;
    expect(await phone.client.leave()).toEqual({ ok: true });
    await until(async () => {
      for (const s of [a, b]) {
        if (entryIn(s, id)?.removedAt === undefined || (await pairedWith(s, id))) return false;
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
    expect(phone.client.members().find((m) => m.id === idMac)).toMatchObject({ links: false, linked: true, name: 'old' });
  }, 30_000);
});
