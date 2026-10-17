import { describe, expect, it, afterEach, vi } from 'vitest';
import { formatFingerprint, publicKeyOf } from '@orbital/shared/remote/keys';
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
    const confirm = await a.api('POST', '/api/remote/pair/confirm', {
      accept: true, phone: statusB.macId, code: join.json().code,
    });
    expect(confirm.statusCode).toBe(200);
    await until(() => a.remote.channel(statusB.macId)?.ready === true && b.remote.channel(statusA.macId)?.ready === true);
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

  it('B restarts: the channel comes back and asks work again', async () => {
    const { a, b, idA, idB } = await joined();
    await b.api('POST', '/api/remote/restart');
    await until(() => a.remote.channel(idB)?.ready === true && b.remote.channel(idA)?.ready === true, 10_000);
    expect((await b.remote.channel(idA)!.request('GET', '/api/health')).status).toBe(200);
    expect((await a.remote.channel(idB)!.request('GET', '/api/health')).status).toBe(200);
  }, 20_000);

  it('a phone still pairs with B after B joined A', async () => {
    const { b } = await joined();
    const pair = await b.api('POST', '/api/remote/pair');
    expect(pair.statusCode).toBe(200);
    const phone = new FakePhone();
    closers.push(() => phone.close());
    await phone.connect(pair.json().qr);
    expect((await phone.redeem()).status).toBe(200);
    await until(async () => (await b.api('GET', '/api/remote')).json().pendingPair !== null);
    const status = (await b.api('GET', '/api/remote')).json();
    expect(status.pendingPair).toMatchObject({ phone: phone.id, kind: 'phone' });
    const code = pairingCode(status.macId, phone.identity.publicKey);
    // The relay tells the phone `paired` before it answers B's confirm, and the phone handshakes then.
    const confirm = b.api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.id, code });
    expect(await phone.nextControl('paired')).toMatchObject({ type: 'paired' });
    await phone.handshake();
    expect((await confirm).statusCode).toBe(200);
    await until(async () => (await b.api('GET', '/api/remote')).json().devices.some((d: any) => d.id === phone.id && d.online));
    expect(await phone.hello()).toMatchObject({ t: 'hello', macName: 'laptop' });
    phone.send({ t: 'http', id: 1, method: 'GET', path: '/api/sessions' });
    expect(await phone.next('http_res', (m) => m.id === 1)).toMatchObject({ status: 200 });
  }, 20_000);

  const membersOf = async (s: { api: (m: 'GET', u: string) => Promise<{ json(): any }> }) =>
    (await s.api('GET', '/api/remote')).json().group.members;

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

  it('a device paired with one member links with the others without a ceremony', async () => {
    const { a, b, idA, idB } = await joined();                           // A ↔ B
    const c = await startMacAndRelay(closers, { relayUrl: a.relayUrl, name: 'vps' });
    const qr = (await b.api('POST', '/api/remote/pair')).json().qr;     // C joins through B
    const join = await c.api('POST', '/api/remote/join', { code: qr });
    await until(async () => (await b.api('GET', '/api/remote')).json().pendingPair !== null);
    const idC = (await c.api('GET', '/api/remote')).json().macId;
    await b.api('POST', '/api/remote/pair/confirm', { accept: true, phone: idC, code: join.json().code });
    await until(() => a.remote.channel(idC)?.ready === true && c.remote.channel(idA)?.ready === true, 15_000);
    expect((await a.remote.channel(idC)!.request('GET', '/api/health')).status).toBe(200);
    expect((await c.remote.channel(idA)!.request('GET', '/api/health')).status).toBe(200);
    for (const s of [a, b, c]) {
      const members = (await s.api('GET', '/api/remote')).json().group.members;
      expect(members.filter((m: any) => m.linked || m.self)).toHaveLength(3);
    }
    void idB;
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

  it('refuses a code from another relay and a code that is not one', async () => {
    const a = await startMacAndRelay(closers);
    const b = await startMacAndRelay(closers);
    const qr = (await a.api('POST', '/api/remote/pair')).json().qr;
    expect((await b.api('POST', '/api/remote/join', { code: qr })).json()).toEqual({ error: 'other_relay' });
    expect((await b.api('POST', '/api/remote/join', { code: 'nonsense' })).statusCode).toBe(400);
  });
});
