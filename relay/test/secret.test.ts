import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { deviceId, generateIdentity, type Identity } from '@orbital/shared/remote/keys';
import { CLOSE_BAD_SECRET, authSignature, signRequest } from '@orbital/shared/remote/relayApi';
import { buildRelay } from '../src/app.js';
import { readSecret } from '../src/config.js';
import { secretMatches } from '../src/secret.js';
import { openRelayStore } from '../src/store.js';
import { connectDevice, listen } from './helpers.js';

const SECRET = 'abcd1234';

describe('relay secret', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  async function relay(secret?: string) {
    const store = await openRelayStore(':memory:');
    const app = await buildRelay({ store, secret });
    const base = await listen(app);
    closers.push(() => app.close());
    const post = (path: string, body: unknown) =>
      app.inject({ method: 'POST', url: path, payload: body as any });
    return { app, base, post, mac: generateIdentity(), phone: generateIdentity() };
  }

  /** Authenticates with a valid signature and the given secret; answers 'ok' or the close code. */
  async function authenticate(base: string, identity: Identity, secret?: string): Promise<'ok' | number> {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
    return new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse((raw as Buffer).toString('utf8'));
        if (msg.type === 'challenge') {
          ws.send(JSON.stringify({
            type: 'auth', pub: deviceId(identity.publicKey), sig: authSignature(identity, msg.nonce),
            ...(secret === undefined ? {} : { secret }),
          }));
        } else if (msg.type === 'ok') {
          ws.close();
          resolve('ok');
        }
      });
      ws.once('close', (code) => resolve(code));
    });
  }

  it('closes a WebSocket that brings no secret or a wrong one, and lets the right one in', async () => {
    const r = await relay(SECRET);
    expect(await authenticate(r.base, r.mac)).toBe(CLOSE_BAD_SECRET);
    expect(await authenticate(r.base, r.mac, 'wrong')).toBe(CLOSE_BAD_SECRET);
    expect(await authenticate(r.base, r.mac, SECRET)).toBe('ok');
  });

  it('answers a pairing token request without the secret with 401 bad_secret', async () => {
    const r = await relay(SECRET);
    const bare = await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }));
    expect(bare.statusCode).toBe(401);
    expect(bare.json()).toEqual({ error: 'bad_secret' });
    const wrong = await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, Date.now(), 'wrong'));
    expect(wrong.statusCode).toBe(401);
    const right = await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, Date.now(), SECRET));
    expect(right.statusCode).toBe(200);
    expect(right.json()).toHaveProperty('token');
  });

  it('refuses a redeem with a wrong secret before the token is looked at', async () => {
    const r = await relay(SECRET);
    await connectDevice(r.base, r.mac, undefined, '', SECRET);
    const { token } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, Date.now(), SECRET))).json();
    const redeem = (t: string, secret?: string) => r.post('/pair/redeem',
      signRequest(r.phone, 'pair.redeem', { token: t, name: 'P', platform: 'android', proof: 'p' }, Date.now(), secret));
    const refused = await redeem(token);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toEqual({ error: 'bad_secret' });
    expect((await redeem('nope', 'wrong')).statusCode).toBe(401);
    // The refusal left the token unspent, and the secret alone does not make a bad token good.
    expect((await redeem('nope', SECRET)).statusCode).toBe(404);
    expect((await redeem(token, SECRET)).statusCode).toBe(200);
  });

  it('refuses confirm and revoke without the secret too', async () => {
    const r = await relay(SECRET);
    const phone = deviceId(r.phone.publicKey);
    const confirm = await r.post('/pair/confirm', signRequest(r.mac, 'pair.confirm', { phone, accept: true }));
    expect(confirm.json()).toEqual({ error: 'bad_secret' });
    const revoke = await r.post('/pair/revoke', signRequest(r.mac, 'pair.revoke', { phone }));
    expect(revoke.json()).toEqual({ error: 'bad_secret' });
  });

  it('an open relay takes requests with a secret and without one', async () => {
    const r = await relay();
    expect(await authenticate(r.base, r.mac)).toBe('ok');
    expect(await authenticate(r.base, r.mac, 'anything')).toBe('ok');
    expect((await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }))).statusCode).toBe(200);
    expect((await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, Date.now(), 'anything'))).statusCode).toBe(200);
  });
});

describe('secretMatches', () => {
  it('matches only the same string, and never throws on a length mismatch', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(SECRET, 'abcd1235')).toBe(false);
    expect(secretMatches(SECRET, undefined)).toBe(false);
    expect(secretMatches(SECRET, `${SECRET}x`)).toBe(false);
    expect(secretMatches(SECRET, '')).toBe(false);
  });
});

describe('readSecret', () => {
  it('trims RELAY_SECRET, so a trailing newline from how a deploy sets it still matches', () => {
    expect(readSecret({ RELAY_SECRET: `${SECRET}\n` })).toBe(SECRET);
  });

  it('treats unset or blank as open', () => {
    expect(readSecret({})).toBe(null);
    expect(readSecret({ RELAY_SECRET: '   ' })).toBe(null);
  });
});
