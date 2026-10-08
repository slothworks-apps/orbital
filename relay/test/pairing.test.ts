import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { generateIdentity, deviceId } from '@orbital/shared/remote/keys';
import { PAIRING_TOKEN_TTL_MS, SEALED_DEVICE_MAX_CHARS, signRequest } from '@orbital/shared/remote/relayApi';
import { RELAY_VERSION_HEADER } from '@orbital/shared/remote/version';
import { buildRelay } from '../src/app.js';
import { PAIR_RATE_LIMIT_PER_MIN } from '../src/rateLimit.js';
import { openRelayStore } from '../src/store.js';
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
    return { store, app, base, mac, phone, post, tick: (ms: number) => { now += ms; }, now: () => now };
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

  it('lets a WebView redeem across origins, and only redeem', async () => {
    const r = await relay();
    const preflight = await r.app.inject({
      method: 'OPTIONS', url: '/pair/redeem',
      headers: { origin: 'https://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-methods']).toBe('POST');
    expect(preflight.headers['access-control-allow-headers']).toBe('content-type');
    // A refusal must be readable too, or the phone sees a network error where it should say "code expired".
    const refused = await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token: 'nope', name: 'P', platform: 'android', proof: 'p' }, r.now()));
    expect(refused.statusCode).toBe(404);
    expect(refused.headers['access-control-allow-origin']).toBe('*');
    // The phone checks the relay's version in the redeem's answer, which a WebView reads only when CORS exposes it.
    expect(refused.headers[RELAY_VERSION_HEADER]).toBe(RELAY_PACKAGE_VERSION);
    expect(refused.headers['access-control-expose-headers']).toBe(RELAY_VERSION_HEADER);
    // The Mac's routes stay closed to browsers.
    const minted = await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()));
    expect(minted.headers['access-control-allow-origin']).toBeUndefined();
    expect(minted.headers[RELAY_VERSION_HEADER]).toBe(RELAY_PACKAGE_VERSION);
    expect((await r.app.inject({ method: 'OPTIONS', url: '/pair/confirm' })).statusCode).toBe(404);
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
});
