import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { generateIdentity, deviceId, publicKeyOf } from '@orbital/shared/remote/keys';
import { FLAG_STATE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import {
  MUTUAL_PAIR_TTL_MS, PAIRING_TOKEN_TTL_MS, SEALED_DEVICE_MAX_CHARS, signRequest,
} from '@orbital/shared/remote/relayApi';
import { RELAY_VERSION_HEADER } from '@orbital/shared/remote/version';
import { buildRelay } from '../src/app.js';
import { MUTUAL_RATE_LIMIT_PER_MIN, PAIR_RATE_LIMIT_PER_MIN } from '../src/rateLimit.js';
import { MUTUAL_HALVES_PER_DEVICE, openRelayStore } from '../src/store.js';
import { connectDevice, listen, sleep } from './helpers.js';

const RELAY_PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

describe('pairing', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  async function relay() {
    let now = 1_000_000;
    const store = await openRelayStore(':memory:');
    const app = await buildRelay({ store, now: () => now });
    const base = await listen(app);
    closers.push(() => app.close());
    const mac = generateIdentity();
    const phone = generateIdentity();
    const post = (path: string, body: unknown) =>
      app.inject({ method: 'POST', url: path, payload: body as any });
    /** Rows for these keys, as a code once gave them: a mutual half waits only for a device the relay knows. */
    const know = async (...ids: ReturnType<typeof generateIdentity>[]) => {
      for (const id of ids) await store.ensureDevice({ id: deviceId(id.publicKey), kind: 'mac' });
    };
    return { store, app, base, mac, phone, post, know, tick: (ms: number) => { now += ms; }, now: () => now };
  }

  it('mints a token for a signed Mac, and redeeming it hands the online Mac the sealed device', async () => {
    const r = await relay();
    const m = await connectDevice(r.base, r.mac);
    const minted = await r.post('/pair/token', signRequest(r.mac, 'pair.token', {}, r.now()));
    expect(minted.statusCode).toBe(200);
    const { token, expiresAt } = minted.json();
    expect(expiresAt).toBe(r.now() + PAIRING_TOKEN_TTL_MS);
    const redeemed = await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, proof: 'p', device: 'sealed' }, r.now()));
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toEqual({ mac: m.id });
    const req = await m.next('pair_request');
    // Empty name and platform: a Mac from before sealed devices requires both.
    expect(req).toEqual({
      type: 'pair_request', phone: deviceId(r.phone.publicKey), proof: 'p', device: 'sealed', name: '', platform: '',
    });
  });

  it('takes the names a Mac and a phone from before send, and passes none of them on', async () => {
    const r = await relay();
    const m = await connectDevice(r.base, r.mac);
    const p = await connectDevice(r.base, r.phone);
    const minted = await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()));
    expect(minted.statusCode).toBe(200);
    const { token } = minted.json();
    const redeemed = await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, name: 'Pixel', platform: 'android', proof: 'p' }, r.now()));
    expect(redeemed.statusCode).toBe(200);
    expect(JSON.stringify(redeemed.json())).not.toContain('studio');
    expect(await m.next('pair_request')).toEqual({ type: 'pair_request', phone: p.id, proof: 'p', name: '', platform: '' });
    await r.post('/pair/confirm', signRequest(r.mac, 'pair.confirm', { phone: p.id, accept: true }, r.now()));
    expect(await p.next('paired')).toEqual({ type: 'paired', mac: m.id, name: '' });
  });

  it('refuses a sealed device over the size it holds', async () => {
    const r = await relay();
    await connectDevice(r.base, r.mac);
    const { token } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', {}, r.now()))).json();
    const device = 'A'.repeat(SEALED_DEVICE_MAX_CHARS + 1);
    const res = await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, proof: 'p', device }, r.now()));
    expect(res.statusCode).toBe(400);
  });

  it('lets a WebView call every signed pair route across origins', async () => {
    const r = await relay();
    for (const path of ['/pair/redeem', '/pair/token', '/pair/confirm', '/pair/mutual', '/pair/revoke']) {
      const preflight = await r.app.inject({
        method: 'OPTIONS', url: path,
        headers: { origin: 'https://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('*');
      expect(preflight.headers['access-control-allow-methods']).toBe('POST');
      expect(preflight.headers['access-control-allow-headers']).toBe('content-type');
    }
    // A refusal must be readable too, or the phone sees a network error where it should say "code expired".
    const refused = await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token: 'nope', name: 'P', platform: 'android', proof: 'p' }, r.now()));
    expect(refused.statusCode).toBe(404);
    expect(refused.headers['access-control-allow-origin']).toBe('*');
    // The phone checks the relay's version in each answer, which a WebView reads only when CORS exposes it.
    expect(refused.headers[RELAY_VERSION_HEADER]).toBe(RELAY_PACKAGE_VERSION);
    expect(refused.headers['access-control-expose-headers']).toBe(RELAY_VERSION_HEADER);
    const minted = await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()));
    expect(minted.statusCode).toBe(200);
    expect(minted.headers['access-control-allow-origin']).toBe('*');
    expect(minted.headers[RELAY_VERSION_HEADER]).toBe(RELAY_PACKAGE_VERSION);
    const bogusConfirm = await r.post('/pair/confirm', signRequest(r.mac, 'pair.confirm', { phone: deviceId(r.phone.publicKey), accept: true }, r.now()));
    expect(bogusConfirm.headers['access-control-allow-origin']).toBe('*');
    const bogusMutual = await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: deviceId(r.phone.publicKey) }, r.now()));
    expect(bogusMutual.headers['access-control-allow-origin']).toBe('*');
    const bogusRevoke = await r.post('/pair/revoke', signRequest(r.mac, 'pair.revoke', { phone: deviceId(r.phone.publicKey) }, r.now()));
    expect(bogusRevoke.headers['access-control-allow-origin']).toBe('*');
  });

  it('a device the relay already knows as a phone keeps that kind after it shows its own code', async () => {
    const r = await relay();
    await connectDevice(r.base, r.mac);
    // The phone redeems first, which records it as a phone.
    const minted = await r.post('/pair/token', signRequest(r.mac, 'pair.token', {}, r.now()));
    const { token } = minted.json();
    await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, proof: 'p' }, r.now()));
    expect((await r.store.device(deviceId(r.phone.publicKey)))?.kind).toBe('phone');
    // The same device then shows its own code, minting a token through /pair/token.
    const ownToken = await r.post('/pair/token', signRequest(r.phone, 'pair.token', {}, r.now()));
    expect(ownToken.statusCode).toBe(200);
    expect((await r.store.device(deviceId(r.phone.publicKey)))?.kind).toBe('phone');
  });

  it('a device the relay has never met is recorded as a mac by /pair/token, as before', async () => {
    const r = await relay();
    await r.post('/pair/token', signRequest(r.mac, 'pair.token', {}, r.now()));
    expect((await r.store.device(deviceId(r.mac.publicKey)))?.kind).toBe('mac');
  });

  it('a token redeems once and not after its ttl', async () => {
    const r = await relay();
    await connectDevice(r.base, r.mac);
    const { token } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()))).json();
    const redeem = () => r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, name: 'P', platform: 'android', proof: 'p' }, r.now()));
    expect((await redeem()).statusCode).toBe(200);
    expect((await redeem()).statusCode).toBe(404);
    const { token: late } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()))).json();
    r.tick(PAIRING_TOKEN_TTL_MS + 1);
    const lateRes = await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token: late, name: 'P', platform: 'android', proof: 'p' }, r.now()));
    expect(lateRes.statusCode).toBe(404);
  });

  it('redeem answers 409 while the Mac is offline', async () => {
    const r = await relay();
    const { token } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()))).json();
    const res = await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, name: 'P', platform: 'android', proof: 'p' }, r.now()));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'mac_offline' });
  });

  it('a 409 leaves the code good: redeemed again once the Mac is online, while it lasts', async () => {
    const r = await relay();
    const { token } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', {}, r.now()))).json();
    const redeem = () => r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, proof: 'p' }, r.now()));
    expect((await redeem()).statusCode).toBe(409);
    const m = await connectDevice(r.base, r.mac);
    const res = await redeem();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mac: m.id });
    expect(await m.next('pair_request')).toMatchObject({ type: 'pair_request', phone: deviceId(r.phone.publicKey) });
    // Passed on, it is used up.
    expect((await redeem()).statusCode).toBe(404);
  });

  it('confirm pairs and tells the phone; reject tells the phone; revoke unpairs', async () => {
    const r = await relay();
    const m = await connectDevice(r.base, r.mac);
    const p = await connectDevice(r.base, r.phone);
    const { token } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()))).json();
    await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, name: 'P', platform: 'android', proof: 'p' }, r.now()));
    await m.next('pair_request');
    const confirmed = await r.post('/pair/confirm', signRequest(r.mac, 'pair.confirm', { phone: p.id, accept: true }, r.now()));
    expect(confirmed.statusCode).toBe(200);
    expect(await p.next('paired')).toEqual({ type: 'paired', mac: m.id, name: '' });
    expect(await r.store.isPaired(m.id, p.id)).toBe(true);
    expect((await r.post('/pair/confirm', signRequest(r.mac, 'pair.confirm', { phone: p.id, accept: true }, r.now()))).statusCode).toBe(404);

    const revoked = await r.post('/pair/revoke', signRequest(r.mac, 'pair.revoke', { phone: p.id }, r.now()));
    expect(revoked.statusCode).toBe(200);
    expect(await p.next('unpaired')).toEqual({ type: 'unpaired', mac: m.id });
    expect(await r.store.isPaired(m.id, p.id)).toBe(false);

    const { token: t2 } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()))).json();
    await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token: t2, name: 'P', platform: 'android', proof: 'p' }, r.now()));
    await r.post('/pair/confirm', signRequest(r.mac, 'pair.confirm', { phone: p.id, accept: false }, r.now()));
    expect(await p.next('rejected')).toEqual({ type: 'rejected', mac: m.id });
    expect(await r.store.isPaired(m.id, p.id)).toBe(false);
  });

  it('revoke answers 404 and does nothing when the two were never paired', async () => {
    const r = await relay();
    const m = await connectDevice(r.base, r.mac);
    const a = await connectDevice(r.base, r.phone);
    const b = await connectDevice(r.base, generateIdentity());
    const { token } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()))).json();
    await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, name: 'A', platform: 'android', proof: 'p' }, r.now()));
    await m.next('pair_request');
    await r.post('/pair/confirm', signRequest(r.mac, 'pair.confirm', { phone: a.id, accept: true }, r.now()));
    await a.next('paired');

    const revoked = await r.post('/pair/revoke', signRequest(r.mac, 'pair.revoke', { phone: b.id }, r.now()));
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json()).toEqual({ error: 'not_paired' });
    // b was never paired with the Mac, so it must hear nothing about it.
    await sleep(50);
    expect(b.control.some((msg) => msg.type === 'unpaired')).toBe(false);
    // a's pair is untouched by the failed revoke of an unrelated phone.
    expect(await r.store.isPaired(m.id, a.id)).toBe(true);
  });

  it('one half: a device that names another forms no pair on its own', async () => {
    const r = await relay();
    const a = await connectDevice(r.base, r.mac);
    const res = await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: deviceId(r.phone.publicKey) }, r.now()));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ linked: false });
    expect(await r.store.isPaired(a.id, deviceId(r.phone.publicKey))).toBe(false);
  });

  it('both halves: the pair forms, both hear linked and presence', async () => {
    const r = await relay();
    await r.know(r.mac, r.phone);
    const a = await connectDevice(r.base, r.mac);
    const b = await connectDevice(r.base, r.phone);
    await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b.id }, r.now()));
    const res = await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a.id }, r.now()));
    expect(res.json()).toEqual({ linked: true });
    expect(await a.next('linked')).toEqual({ type: 'linked', peer: b.id });
    expect(await b.next('linked')).toEqual({ type: 'linked', peer: a.id });
    expect(await a.next('presence')).toEqual({ type: 'presence', peer: b.id, online: true });
    expect(await r.store.isPaired(a.id, b.id)).toBe(true);
  });

  it('a half older than MUTUAL_PAIR_TTL_MS is gone', async () => {
    const r = await relay();
    const a = deviceId(r.mac.publicKey);
    const b = deviceId(r.phone.publicKey);
    await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b }, r.now()));
    r.tick(MUTUAL_PAIR_TTL_MS + 1);
    const res = await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a }, r.now()));
    expect(res.json()).toEqual({ linked: false });
  });

  it('asking again once paired answers linked and changes nothing', async () => {
    const r = await relay();
    await r.know(r.mac, r.phone);
    const a = deviceId(r.mac.publicKey);
    const b = deviceId(r.phone.publicKey);
    await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b }, r.now()));
    await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a }, r.now()));
    const again = await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b }, r.now()));
    expect(again.json()).toEqual({ linked: true });
  });

  it('refuses a peer that is not a device id, or the signer itself', async () => {
    const r = await relay();
    expect((await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: 'nope' }, r.now()))).statusCode).toBe(400);
    expect((await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: deviceId(r.mac.publicKey) }, r.now()))).statusCode).toBe(400);
  });

  it('either side of a mutual pair may revoke it', async () => {
    const r = await relay();
    await r.know(r.mac, r.phone);
    const a = deviceId(r.mac.publicKey);
    const b = await connectDevice(r.base, r.phone);
    await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b.id }, r.now()));
    await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a }, r.now()));
    const res = await r.post('/pair/revoke', signRequest(r.phone, 'pair.revoke', { phone: a }, r.now()));
    expect(res.statusCode).toBe(200);
    expect(await r.store.isPaired(a, b.id)).toBe(false);
  });

  it('a half signed before a revoke cannot complete a pair after it', async () => {
    const r = await relay();
    const a = deviceId(r.mac.publicKey);
    const c = deviceId(r.phone.publicKey);
    await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: c }, r.now()));
    const revoked = await r.post('/pair/revoke', signRequest(r.mac, 'pair.revoke', { phone: c }, r.now()));
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json()).toEqual({ error: 'not_paired' });
    const res = await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a }, r.now()));
    expect(res.json()).toEqual({ linked: false });
    expect(await r.store.isPaired(a, c)).toBe(false);
  });

  it('a revoke keeps the frames another pair queued for the revoked device', async () => {
    const r = await relay();
    const third = generateIdentity();
    await r.know(r.mac, r.phone, third);
    const x = deviceId(r.phone.publicKey);
    const a = deviceId(r.mac.publicKey);
    const b = await connectDevice(r.base, third);
    for (const [one, other] of [[r.mac, x], [third, x], [r.phone, a], [r.phone, b.id]] as const) {
      await r.post('/pair/mutual', signRequest(one, 'pair.mutual', { peer: other }, r.now()));
    }
    await b.next('linked');
    const wake = new Uint8Array(16).fill(7);
    b.ws.send(encodeFrame({ peer: publicKeyOf(x)!, flags: FLAG_STATE, wake, body: new Uint8Array() }));
    await sleep(50);
    expect((await r.post('/pair/revoke', signRequest(r.mac, 'pair.revoke', { phone: x }, r.now()))).statusCode).toBe(200);
    const p = await connectDevice(r.base, r.phone);
    expect(decodeFrame(await p.nextData())!.wake).toEqual(wake);
  });

  it('rejects an unsigned or wrongly signed request', async () => {
    const r = await relay();
    expect((await r.post('/pair/token', { name: 'studio' })).statusCode).toBe(401);
    const wrongAction = signRequest(r.mac, 'pair.revoke', { name: 'studio' }, r.now());
    expect((await r.post('/pair/token', wrongAction)).statusCode).toBe(401);
  });

  it('rate-limits signed requests per IP; unsigned junk does not use the limit up', async () => {
    const r = await relay();
    const mint = (remoteAddress = '127.0.0.1') => r.app.inject({
      method: 'POST', url: '/pair/token', remoteAddress,
      payload: signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()),
    });
    for (let i = 0; i < PAIR_RATE_LIMIT_PER_MIN * 2; i++) {
      expect((await r.post('/pair/token', { name: 'junk' })).statusCode).toBe(401);
    }
    for (let i = 0; i < PAIR_RATE_LIMIT_PER_MIN; i++) expect((await mint()).statusCode).toBe(200);
    const limited = await mint();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'rate_limited' });
    expect((await mint('10.0.0.2')).statusCode).toBe(200);
    r.tick(60_000);
    expect((await mint()).statusCode).toBe(200);
  });

  it('a half alone makes no row for a signer the relay never met; the pair it completes does', async () => {
    const r = await relay();
    await r.know(r.phone);
    const a = deviceId(r.mac.publicKey);
    const b = deviceId(r.phone.publicKey);
    await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b }, r.now()));
    expect(await r.store.device(a)).toBeNull();
    const res = await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a }, r.now()));
    expect(res.json()).toEqual({ linked: true });
    expect(await r.store.device(a)).toMatchObject({ id: a, kind: 'mac' });
  });

  it('keeps no half for a peer the relay does not know', async () => {
    const r = await relay();
    await r.know(r.mac);
    const a = deviceId(r.mac.publicKey);
    // The phone is unknown: the Mac's half to it is not kept, so the phone's own finds nothing to complete.
    await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: deviceId(r.phone.publicKey) }, r.now()));
    const res = await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a }, r.now()));
    expect(res.json()).toEqual({ linked: false });
  });

  it('keeps at most MUTUAL_HALVES_PER_DEVICE halves of one signer waiting; its oldest goes first', async () => {
    const r = await relay();
    const peers = Array.from({ length: MUTUAL_HALVES_PER_DEVICE + 1 }, () => generateIdentity());
    await r.know(...peers);
    for (const peer of peers) {
      await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: deviceId(peer.publicKey) }, r.now()));
      r.tick(1);
    }
    const a = deviceId(r.mac.publicKey);
    // The first half went when the last came; the second still waits and completes.
    const first = await r.post('/pair/mutual', signRequest(peers[0], 'pair.mutual', { peer: a }, r.now()));
    expect(first.json()).toEqual({ linked: false });
    const second = await r.post('/pair/mutual', signRequest(peers[1], 'pair.mutual', { peer: a }, r.now()));
    expect(second.json()).toEqual({ linked: true });
  });

  it('keys made up on the spot behind one address do not use up a known device\'s mutual budget there', async () => {
    const r = await relay();
    // The phone is known to the relay: it showed a code once.
    await r.post('/pair/token', signRequest(r.phone, 'pair.token', {}, r.now()));
    const peer = deviceId(r.mac.publicKey);
    const mutual = (who: ReturnType<typeof generateIdentity>) => r.post('/pair/mutual', signRequest(who, 'pair.mutual', { peer }, r.now()));
    let limited = 0;
    for (let i = 0; i <= MUTUAL_RATE_LIMIT_PER_MIN; i++) if ((await mutual(generateIdentity())).statusCode === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    expect((await mutual(r.phone)).statusCode).toBe(200);
  });

  it('answers 429 to a half while the relay holds as many as it keeps', async () => {
    const store = await openRelayStore(':memory:', { halvesMax: 0 });
    const app = await buildRelay({ store, now: () => 1_000_000 });
    closers.push(() => app.close());
    const [a, b] = [generateIdentity(), generateIdentity()];
    await store.ensureDevice({ id: deviceId(b.publicKey), kind: 'mac' });
    const res = await app.inject({
      method: 'POST', url: '/pair/mutual', payload: signRequest(a, 'pair.mutual', { peer: deviceId(b.publicKey) }, 1_000_000),
    });
    expect(res.statusCode).toBe(429);
  });

  it('a relay that lost its store pairs two connected devices again through their halves', async () => {
    const r = await relay();
    const a = await connectDevice(r.base, r.mac);
    const b = await connectDevice(r.base, r.phone);
    expect(await r.store.device(a.id)).toBeNull();
    expect(await r.store.device(b.id)).toBeNull();
    expect((await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b.id }, r.now()))).json()).toEqual({ linked: false });
    expect((await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a.id }, r.now()))).json()).toEqual({ linked: true });
    expect(await r.store.isPaired(a.id, b.id)).toBe(true);
    expect(await r.store.device(a.id)).not.toBeNull();
    expect(await r.store.device(b.id)).not.toBeNull();
  });
});
