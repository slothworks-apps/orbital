import { describe, expect, it, afterEach, vi } from 'vitest';
import { formatFingerprint, publicKeyOf } from '@orbital/shared/remote/keys';
import { PAIR_NAME_MAX_CHARS } from '@orbital/shared/remote/relayApi';
import { memberIds } from '@orbital/shared/remote/roster';
import { FakePhone } from './remoteFakePhone.js';
import { RelayClient } from '../src/remote/relayClient.js';
import { pairingCode, startMacAndRelay, until, type MacAndRelay } from './remoteHarness.js';

describe('two servers, one channel', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const c of closers.splice(0).reverse()) await c();
  });

  async function joined() {
    const a = await startMacAndRelay(closers, { name: 'studio' });
    const b = await startMacAndRelay(closers, { relayUrl: a.relayUrl, name: 'laptop' });
    const qr = (await a.api('POST', '/api/remote/pair')).json().qr;
    const join = await b.api('POST', '/api/remote/join', { code: qr });
    expect(join.statusCode).toBe(200);
    await until(async () => (await a.api('GET', '/api/remote')).json().pendingPair !== null);
    const statusA = (await a.api('GET', '/api/remote')).json();
    expect(statusA.pendingPair).toMatchObject({ name: 'laptop', kind: 'desktop' });
    const statusB = (await b.api('GET', '/api/remote')).json();
    expect(join.json().code).toBe(formatFingerprint(pairingCode(statusA.macId, publicKeyOf(statusB.macId)!)));
    // A reload while waiting keeps the code to type.
    expect(statusB.joining).toMatchObject({ device: statusA.macId, code: join.json().code });
    const confirm = await a.api('POST', '/api/remote/pair/confirm', {
      accept: true, phone: statusB.macId, code: join.json().code,
    });
    expect(confirm.statusCode).toBe(200);
    await until(() => a.remote.channel(statusB.macId)?.ready === true && b.remote.channel(statusA.macId)?.ready === true);
    // B holds A's roster: it knows its group, and its primary.
    await until(() => b.remote.rosterState().roster?.group === statusA.macId);
    expect((await b.api('GET', '/api/remote')).json().joining).toBeNull();
    return { a, b, idA: statusA.macId as string, idB: statusB.macId as string };
  }

  it('pairs a Mac with a Mac and asks in both directions', async () => {
    const { a, b, idA, idB } = await joined();
    const aboutA = await b.remote.channel(idA)!.request('GET', '/api/health');
    const aboutB = await a.remote.channel(idB)!.request('GET', '/api/health');
    expect(aboutA.status).toBe(200);
    expect(aboutB.status).toBe(200);
    expect(a.remote.channel(idB)!.peer).toMatchObject({ kind: 'desktop', name: 'laptop' });
    const devicesB = (await b.api('GET', '/api/remote')).json().devices;
    expect(devicesB).toEqual([expect.objectContaining({ id: idA, name: 'studio', kind: 'desktop' })]);
  }, 20_000);

  it('a member\'s ask reaches the route marked as a member\'s: settings save, remote_ ones are refused', async () => {
    const { a, b, idA } = await joined();
    const toA = b.remote.channel(idA)!;
    expect((await toA.request('PATCH', '/api/settings', { theme: 'desk' })).status).toBe(200);
    const refused = await toA.request('PATCH', '/api/settings', { remote_enabled: 'false' });
    expect([refused.status, refused.body]).toEqual([403, { error: 'not_allowed' }]);
    const settingsA = (await a.api('GET', '/api/settings')).json();
    expect(settingsA).toMatchObject({ theme: 'desk', remote_enabled: 'true' });
  }, 20_000);

  it('B restarts: the channel comes back and asks work again', async () => {
    const { a, b, idA, idB } = await joined();
    await b.api('POST', '/api/remote/restart');
    await until(() => a.remote.channel(idB)?.ready === true && b.remote.channel(idA)?.ready === true, 10_000);
    expect((await b.remote.channel(idA)!.request('GET', '/api/health')).status).toBe(200);
    expect((await a.remote.channel(idB)!.request('GET', '/api/health')).status).toBe(200);
  }, 20_000);

  it('a phone pairs with the group only through its primary: B, a member, shows no code', async () => {
    const { a, b, idA } = await joined();
    const refused = await b.api('POST', '/api/remote/pair');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'not_primary', primary: { id: idA, name: 'studio' } });
    expect((await a.api('GET', '/api/remote')).json().group).toMatchObject({ isPrimary: true, primary: { id: idA } });
    expect((await b.api('GET', '/api/remote')).json().group).toMatchObject({ isPrimary: false, primary: { id: idA } });
    const phone = await pairPhone(a, idA);
    phone.send({ t: 'http', id: 1, method: 'GET', path: '/api/sessions' });
    expect(await phone.next('http_res', (m) => m.id === 1)).toMatchObject({ status: 200 });
  }, 20_000);

  const membersOf = async (s: { api: (m: 'GET', u: string) => Promise<{ json(): any }> }) =>
    (await s.api('GET', '/api/remote')).json().group.members;
  /** Whether the latest version `s` holds names `id`, its left notice aside. */
  const isMember = (s: MacAndRelay, id: string) => memberIds(s.remote.rosterState()).includes(id);
  const pairedWith = async (s: MacAndRelay, id: string) =>
    (await s.api('GET', '/api/remote')).json().devices.some((d: any) => d.id === id);

  it('pairing writes both into one roster, and the rosters converge', async () => {
    const { a, b, idA, idB } = await joined();
    await until(async () => {
      const ma = await membersOf(a);
      const mb = await membersOf(b);
      return ma.length === 2 && mb.length === 2 && JSON.stringify(ma.map((m: any) => m.id)) === JSON.stringify(mb.map((m: any) => m.id))
        && a.remote.rosterDigest() === b.remote.rosterDigest();
    });
    const ma = await membersOf(a);
    expect(ma.find((m: any) => m.id === idA)).toMatchObject({ self: true, name: 'studio' });
    expect(ma.find((m: any) => m.id === idB)).toMatchObject({ self: false, name: 'laptop', linked: true, links: true });
    expect(a.remote.rosterDigest()).toBe(b.remote.rosterDigest());
  }, 20_000);

  it('a Mac renamed past the roster\'s bound still converges with its peer', async () => {
    const { a, b, idA } = await joined();
    await until(() => a.remote.rosterDigest() === b.remote.rosterDigest());
    // Its own description is the newest, so no peer's cut copy of its hello can win over it.
    await a.api('PATCH', '/api/settings', { remote_mac_name: 's'.repeat(PAIR_NAME_MAX_CHARS + 40) });
    await until(async () => (await membersOf(b)).find((m: any) => m.id === idA).name === 's'.repeat(PAIR_NAME_MAX_CHARS)
      && a.remote.rosterDigest() === b.remote.rosterDigest(), 10_000);
  }, 20_000);

  /** A FakePhone paired with `mac` through its code, said hello: the sequence a real phone follows. */
  async function pairPhone(mac: MacAndRelay, macId: string): Promise<FakePhone> {
    const pair = await mac.api('POST', '/api/remote/pair');
    const phone = new FakePhone();
    closers.push(() => phone.close());
    await phone.connect(pair.json().qr);
    expect((await phone.redeem()).status).toBe(200);
    await until(async () => (await mac.api('GET', '/api/remote')).json().pendingPair !== null);
    const code = pairingCode(macId, phone.identity.publicKey);
    // The relay tells the phone `paired` before it answers the Mac's confirm, and the phone handshakes then.
    const confirm = mac.api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.id, code });
    expect(await phone.nextControl('paired')).toMatchObject({ type: 'paired' });
    await phone.handshake();
    expect((await confirm).statusCode).toBe(200);
    expect(await phone.hello()).toMatchObject({ t: 'hello' });
    return phone;
  }

  it('a phone paired with a member is listed, not linked with others', async () => {
    const { a, b, idA } = await joined();
    const phone = await pairPhone(a, idA);
    expect((await membersOf(a)).find((m: any) => m.id === phone.id)).toMatchObject({
      kind: 'phone', name: 'Pixel', os: 'android', links: false, linked: true, self: false,
    });
    await until(async () => (await membersOf(b)).some((m: any) => m.id === phone.id));
    expect((await membersOf(b)).find((m: any) => m.id === phone.id)).toMatchObject({
      kind: 'phone', links: false, linked: false, online: false,
    });
    await until(() => a.remote.rosterDigest() === b.remote.rosterDigest());
  }, 20_000);

  /** A ↔ B by a ceremony, C joined through A (the primary), and B ↔ C linked by the mutual pair alone. */
  async function threeLinked() {
    const { a, b, idA, idB } = await joined();
    const c = await startMacAndRelay(closers, { relayUrl: a.relayUrl, name: 'vps' });
    const qr = (await a.api('POST', '/api/remote/pair')).json().qr;
    const join = await c.api('POST', '/api/remote/join', { code: qr });
    await until(async () => (await a.api('GET', '/api/remote')).json().pendingPair !== null);
    const idC = (await c.api('GET', '/api/remote')).json().macId as string;
    await a.api('POST', '/api/remote/pair/confirm', { accept: true, phone: idC, code: join.json().code });
    await until(() => b.remote.channel(idC)?.ready === true && c.remote.channel(idB)?.ready === true
      && a.remote.channel(idC)?.ready === true, 15_000);
    return { a, b, c, idA, idB, idC };
  }

  it('a device paired with the primary links with the others without a ceremony', async () => {
    const { a, b, c, idB, idC } = await threeLinked();
    expect((await b.remote.channel(idC)!.request('GET', '/api/health')).status).toBe(200);
    expect((await c.remote.channel(idB)!.request('GET', '/api/health')).status).toBe(200);
    for (const s of [a, b, c]) {
      const members = (await s.api('GET', '/api/remote')).json().group.members;
      expect(members.filter((m: any) => m.linked || m.self)).toHaveLength(3);
    }
  }, 30_000);

  it('a fourth device joining through the primary learns every member and links with each', async () => {
    const { a, b, c, idA, idB, idC } = await threeLinked();
    const j = await startMacAndRelay(closers, { relayUrl: a.relayUrl, name: 'mini' });
    const qr = (await a.api('POST', '/api/remote/pair')).json().qr;
    const join = await j.api('POST', '/api/remote/join', { code: qr });
    await until(async () => (await a.api('GET', '/api/remote')).json().pendingPair !== null);
    const idJ = (await j.api('GET', '/api/remote')).json().macId as string;
    await a.api('POST', '/api/remote/pair/confirm', { accept: true, phone: idJ, code: join.json().code });
    await until(() => [idA, idB, idC].every((id) => j.remote.channel(id)?.ready === true), 20_000);
    for (const s of [a, b, c, j]) {
      await until(() => s.remote.rosterDigest() === j.remote.rosterDigest(), 10_000);
      expect((await membersOf(s)).map((m: any) => m.id).sort()).toEqual([idA, idB, idC, idJ].sort());
    }
  }, 45_000);

  it('removing a member on the primary removes it everywhere; another member is refused', async () => {
    const { a, b, idA, idC } = await threeLinked();
    const refused = await b.api('DELETE', `/api/remote/devices/${idC}`);
    expect([refused.statusCode, refused.json()]).toEqual([403, { error: 'not_primary', primary: { id: idA, name: 'studio' } }]);
    expect((await a.api('DELETE', `/api/remote/devices/${idC}`)).statusCode).toBe(200);
    await until(async () => {
      for (const s of [a, b]) {
        if (isMember(s, idC) || (await pairedWith(s, idC))) return false;
        if ((await membersOf(s)).some((x: any) => x.id === idC)) return false;
      }
      return b.remote.channel(idC) === null && a.remote.channel(idC) === null;
    }, 15_000);
  }, 30_000);

  /** Only this device, live, linked with nothing: a group of one. */
  const aloneIn = async (s: MacAndRelay) => {
    const status = (await s.api('GET', '/api/remote')).json();
    const members = status.group.members;
    return members.length === 1 && members[0].self === true && members[0].removedAt === undefined
      && !members[0].linked && status.devices.length === 0;
  };

  it('removed device learns: it becomes a group of one', async () => {
    const { a, c, idA, idB } = await threeLinked();
    await a.api('DELETE', `/api/remote/devices/${(await c.api('GET', '/api/remote')).json().macId}`);
    await until(() => aloneIn(c), 15_000);
    // Alone, it holds no roster: the next primary that adds it sends one.
    expect(c.remote.rosterState().roster).toBeNull();
    // The notice names the primary that removed it, until the user acknowledges it.
    expect((await c.api('GET', '/api/remote')).json().group).toMatchObject({
      primary: null, isPrimary: false, ended: { why: 'removed', by: { id: idA, name: 'studio' } },
    });
    expect((await c.api('POST', '/api/remote/ended/acknowledge')).statusCode).toBe(200);
    expect((await c.api('GET', '/api/remote')).json().group.ended).toBeNull();
    expect(c.remote.channel(idA)).toBeNull();
    expect(c.remote.channel(idB)).toBeNull();
  }, 30_000);

  it('a member asleep at a removal drops its pair when it wakes, from the version any member passes on', async () => {
    const { a, b, idC } = await threeLinked();
    await b.api('PATCH', '/api/settings', { remote_enabled: 'false' });
    expect((await b.api('GET', '/api/remote')).json().relay).toBe('off');
    expect((await a.api('DELETE', `/api/remote/devices/${idC}`)).statusCode).toBe(200);
    // B still holds C as a live member it is paired with.
    expect((await b.api('GET', '/api/remote')).json().devices.some((d: any) => d.id === idC)).toBe(true);
    await b.api('PATCH', '/api/settings', { remote_enabled: 'true' });
    await until(async () => {
      return !isMember(b, idC) && !(await pairedWith(b, idC));
    }, 15_000);
  }, 45_000);

  it('leave: a member leaves the group from itself, and the primary leaves it out', async () => {
    const { a, b, idB } = await joined();
    expect((await b.api('POST', '/api/remote/leave')).json()).toEqual({ ok: true });
    await until(async () => {
      return !isMember(a, idB) && !(await pairedWith(a, idB)) && (await aloneIn(b));
    }, 15_000);
    expect(a.remote.channel(idB)).toBeNull();
    expect(a.remote.rosterState().roster).toMatchObject({ version: 2 });
    expect(a.remote.rosterState().left).toEqual([]);
  }, 30_000);

  it('the primary leaving dissolves the group: every member becomes alone, its phones go with it', async () => {
    const { a, b, idA } = await joined();
    const phone = await pairPhone(a, idA);
    await until(async () => (await membersOf(b)).some((m: any) => m.id === phone.id));
    expect((await a.api('POST', '/api/remote/leave')).json()).toEqual({ ok: true });
    await until(async () => (await aloneIn(a)) && (await aloneIn(b)), 15_000);
    expect(a.remote.rosterState().roster).toBeNull();
    expect(b.remote.rosterState().roster).toBeNull();
  }, 30_000);

  it('a device that left pairs again through the ceremony, in a version above the one that left it out', async () => {
    const { a, b, idA, idB } = await joined();
    await b.api('POST', '/api/remote/leave');
    await until(async () => !isMember(a, idB) && (await aloneIn(b)), 15_000);
    const leftOut = a.remote.rosterState().roster!.version;
    const qr = (await a.api('POST', '/api/remote/pair')).json().qr;
    const join = await b.api('POST', '/api/remote/join', { code: qr });
    expect(join.statusCode).toBe(200);
    await until(async () => (await a.api('GET', '/api/remote')).json().pendingPair !== null);
    expect((await a.api('POST', '/api/remote/pair/confirm', { accept: true, phone: idB, code: join.json().code })).statusCode).toBe(200);
    await until(async () => {
      const m = (await membersOf(a)).find((x: any) => x.id === idB);
      return a.remote.channel(idB)?.ready === true && b.remote.channel(idA)?.ready === true
        && m !== undefined && m.linked && a.remote.rosterDigest() === b.remote.rosterDigest();
    }, 15_000);
    expect(a.remote.rosterState().roster!.version).toBeGreaterThan(leftOut);
    expect(b.remote.rosterState().roster).toEqual(a.remote.rosterState().roster);
    expect((await membersOf(b)).find((x: any) => x.id === idA)).toMatchObject({ linked: true });
  }, 30_000);

  it('phone is listed, not linked: no mutual pair is asked for it', async () => {
    const posts = vi.spyOn(RelayClient.prototype, 'post');
    const { a, b, idA } = await joined();
    const phone = await pairPhone(a, idA);
    await until(async () => (await membersOf(b)).some((m: any) => m.id === phone.id)
      && a.remote.rosterDigest() === b.remote.rosterDigest());
    // Long enough for a mutual pair, had one been asked for, to have formed and opened a channel.
    await new Promise((r) => setTimeout(r, 1000));
    expect((await membersOf(b)).find((m: any) => m.id === phone.id)).toMatchObject({
      kind: 'phone', links: false, linked: false, pairByHand: false,
    });
    expect(b.remote.channel(phone.id)).toBeNull();
    const asked = posts.mock.calls.filter(([path]) => path === '/pair/mutual').map(([, , payload]) => (payload as any).peer);
    expect(asked).not.toContain(phone.id);
  }, 20_000);

  it('a member asleep when the primary dissolves the group hears it on waking and ends alone; the pair waits for it', async () => {
    const { a, b, idB } = await joined();
    await b.api('PATCH', '/api/settings', { remote_enabled: 'false' });
    expect((await a.api('POST', '/api/remote/leave')).json()).toEqual({ ok: true });
    // B has not heard: its pair stays, and nothing is served to it meanwhile.
    expect(await pairedWith(a, idB)).toBe(true);
    await b.api('PATCH', '/api/settings', { remote_enabled: 'true' });
    await until(async () => (await aloneIn(a)) && (await aloneIn(b)), 15_000);
    expect(b.remote.rosterState().roster).toBeNull();
  }, 30_000);

  it('leaving with no member reachable is refused, and changes nothing', async () => {
    const { a, b, idB } = await joined();
    await a.api('PATCH', '/api/settings', { remote_enabled: 'false' });
    await until(() => b.remote.channel((a.remote.selfId())!) === null, 10_000);
    const res = await b.api('POST', '/api/remote/leave');
    expect([res.statusCode, res.json()]).toEqual([409, { error: 'offline' }]);
    expect(isMember(b, idB)).toBe(true);
  }, 30_000);

  it('refuses a code from another relay and a code that is not one', async () => {
    const a = await startMacAndRelay(closers);
    const b = await startMacAndRelay(closers);
    const qr = (await a.api('POST', '/api/remote/pair')).json().qr;
    expect((await b.api('POST', '/api/remote/join', { code: qr })).json()).toEqual({ error: 'other_relay', relay: a.relayUrl });
    expect((await b.api('POST', '/api/remote/join', { code: 'nonsense' })).statusCode).toBe(400);
  });
});
