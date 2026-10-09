import { describe, it, expect, afterEach } from 'vitest';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/index.js';
import {
  API_TOKEN_COOKIE,
  API_TOKEN_FILE,
  loadOrCreateApiToken,
  safeNext,
} from '../src/auth/token.js';
import { remoteInjectOptions } from '../src/remote/inject.js';
import { FakePhone } from './remoteFakePhone.js';
import { pairingCode, startMacAndRelay, until } from './remoteHarness.js';
import { makeTmpDir } from './tmp.js';

const TOKEN = 'test-token-0123456789';

describe('loadOrCreateApiToken', () => {
  it('creates the file owner-only, in a dir that did not exist', () => {
    const dir = join(makeTmpDir('token'), 'nested');
    const token = loadOrCreateApiToken(dir);
    expect(token.length).toBeGreaterThan(20);
    expect(statSync(join(dir, API_TOKEN_FILE)).mode & 0o777).toBe(0o600);
  });
  it('a second start reads the same token', () => {
    const dir = makeTmpDir('token');
    expect(loadOrCreateApiToken(dir)).toBe(loadOrCreateApiToken(dir));
  });
  it('reads a hand-written file trimmed', () => {
    const dir = makeTmpDir('token');
    writeFileSync(join(dir, API_TOKEN_FILE), '  abc\n');
    expect(loadOrCreateApiToken(dir)).toBe('abc');
  });
});

describe('safeNext', () => {
  it('keeps a same-origin path', () => {
    expect(safeNext('/session/abc?x=1#y')).toBe('/session/abc?x=1#y');
  });
  it('sends anything else to /', () => {
    for (const next of [undefined, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'evil', '/.//evil.example', '/\t/evil.example']) {
      expect(safeNext(next)).toBe('/');
    }
  });
});

describe('remoteInjectOptions', () => {
  it('carries the bearer', () => {
    expect(remoteInjectOptions({ method: 'GET', url: '/api/sessions' }, TOKEN).headers)
      .toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });
});

describe('the token guard', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  async function makeApp(): Promise<FastifyInstance> {
    const dir = makeTmpDir('guard');
    app = await buildServer({ dbPath: join(dir, 'index.db'), claudeDir: dir, dataDir: dir, apiToken: TOKEN });
    return app;
  }

  it('refuses /api without a token, or with a wrong one', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/sessions' })).statusCode).toBe(401);
    const wrong = await app.inject({ method: 'GET', url: '/api/sessions', headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'unauthorized' });
    const wrongCookie = await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: `${API_TOKEN_COOKIE}=${TOKEN}x` } });
    expect(wrongCookie.statusCode).toBe(401);
  });

  it('guards a session media list, which names files on disk', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/media' })).statusCode).toBe(401);
    const bearer = await app.inject({ method: 'GET', url: '/api/sessions/s1/media', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(bearer.statusCode).toBe(404);
  });

  it('refuses a spelling the router decodes into /api', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/%61pi/sessions' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/%61pi/health' })).json()).toEqual({ app: 'orbital', static: false });
  });

  it('refuses a /ws upgrade without a token', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/ws',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets a correct cookie or bearer through', async () => {
    const app = await makeApp();
    const cookie = await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: `a=b; ${API_TOKEN_COOKIE}=${TOKEN}` } });
    expect(cookie.statusCode).toBe(200);
    const bearer = await app.inject({ method: 'GET', url: '/api/sessions', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(bearer.statusCode).toBe(200);
  });

  it('answers health openly, but only app and static', async () => {
    const app = await makeApp();
    const open = await app.inject({ method: 'GET', url: '/api/health' });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ app: 'orbital', static: false });
    const full = await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(full.json()).toHaveProperty('paths');
  });

  it('/api/auth sets the cookie and redirects to a same-origin next', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/auth?token=${TOKEN}&next=${encodeURIComponent('/sandbox')}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/sandbox');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain(`${API_TOKEN_COOKIE}=${TOKEN}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
  });

  it('/api/auth sends a foreign next to /', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/auth?token=${TOKEN}&next=${encodeURIComponent('//evil.example/x')}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('/api/auth refuses a wrong or missing token', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/auth?token=nope' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/auth' })).statusCode).toBe(401);
  });

  it('refuses a REST call from a foreign Origin, even with the token', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/errors',
      payload: { kind: 'render_crash', message: 'x' },
      headers: { origin: 'http://127.0.0.1:3000', cookie: `${API_TOKEN_COOKIE}=${TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'origin not allowed' });
  });
});

describe('the token guard and the phone', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

  it('an allowlisted call through the relay still answers 200', async () => {
    const { api } = await startMacAndRelay(closers, { apiToken: TOKEN });

    const pair = await api('POST', '/api/remote/pair');
    const phone = new FakePhone();
    closers.push(() => phone.close());
    await phone.connect(pair.json().qr);
    await phone.redeem();
    await until(async () => (await api('GET', '/api/remote')).json().pendingPair !== null);
    const code = pairingCode((await api('GET', '/api/remote')).json().macId, phone.identity.publicKey);
    const confirm = api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.id, code });
    await phone.nextControl('paired');
    await phone.handshake();
    expect((await confirm).statusCode).toBe(200);
    await phone.hello();

    phone.send({ t: 'http', id: 1, method: 'GET', path: '/api/sessions' });
    expect(await phone.next('http_res', (m) => m.id === 1)).toMatchObject({ status: 200 });
  }, 20_000);
});
