import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildServer } from '../src/index.js';
import { BROWSER_BRIDGE_SETTING, BROWSER_CLOSE, BROWSER_EXTENSION_ORIGIN, BROWSER_WS_PATH } from '../src/browser/protocol.js';
import { makeTmpDir } from './tmp.js';

const TOKEN = 'test-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const UPGRADE = {
  upgrade: 'websocket',
  connection: 'Upgrade',
  'sec-websocket-version': '13',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
};

describe('the browser bridge through the server', () => {
  let app: FastifyInstance | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await app?.close();
    app = undefined;
  });

  async function start(listen = false): Promise<number> {
    const dir = makeTmpDir('browser-server');
    app = await buildServer({ dbPath: join(dir, 'index.db'), claudeDir: dir, dataDir: dir, apiToken: TOKEN });
    if (!listen) return 0;
    await app.listen({ host: '127.0.0.1', port: 0 });
    return (app.server.address() as AddressInfo).port;
  }

  const setSwitch = (on: boolean) =>
    app!.inject({ method: 'PATCH', url: '/api/settings', headers: auth, payload: { [BROWSER_BRIDGE_SETTING]: String(on) } });

  // Refusals through `inject`: a refused upgrade on a real socket holds `app.close()` open.
  const upgrade = (url: string, headers: Record<string, string> = {}) =>
    app!.inject({ method: 'GET', url, headers: { ...UPGRADE, ...headers } });

  /** A real socket from the extension's origin; resolves once open, with what it hears and how it closed. */
  function open(port: number, origin: string | null = BROWSER_EXTENSION_ORIGIN) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${BROWSER_WS_PATH}`, origin ? { origin } : {});
    sockets.push(ws);
    const frames: Record<string, any>[] = [];
    let closed: number | null = null;
    ws.on('message', (d: Buffer) => frames.push(JSON.parse(d.toString('utf8'))));
    ws.on('close', (code) => { closed = code; });
    return new Promise<{ ws: WebSocket; frames: typeof frames; closed: () => number | null }>((resolve, reject) => {
      ws.on('open', () => resolve({ ws, frames, closed: () => closed }));
      ws.on('error', reject);
    });
  }

  it('lets only the extension origin open its socket, and never a page', async () => {
    await start();
    await setSwitch(true);
    for (const origin of ['http://evil.example', 'http://127.0.0.1:4737', 'http://localhost:4839', 'chrome-extension://someoneelse']) {
      expect((await upgrade(BROWSER_WS_PATH, { origin })).statusCode).toBe(403);
    }
  });

  it('keeps the extension origin off every other route', async () => {
    await start();
    const origin = BROWSER_EXTENSION_ORIGIN;
    expect((await app!.inject({ method: 'GET', url: '/api/sessions', headers: { ...auth, origin } })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'GET', url: '/api/browser', headers: { ...auth, origin } })).statusCode).toBe(403);
    expect((await upgrade('/ws', { ...auth, origin })).statusCode).toBe(403);
  });

  it('exempts only its own socket from the API token', async () => {
    await start();
    for (const url of ['/ws', '/ws/browserx', '/ws/browser/x', '/ws/terminal/x', '/api/browser']) {
      expect((await upgrade(url)).statusCode).toBe(401);
    }
    for (const [method, url] of [['GET', '/api/browser'], ['POST', '/api/browser/pairing-code'], ['DELETE', '/api/browser/pairings/x'], ['POST', '/api/browser/outcome']] as const) {
      expect((await app!.inject({ method, url, payload: method === 'POST' ? {} : undefined })).statusCode).toBe(401);
    }
    // Not an upgrade: the socket route answers nothing a page could read.
    const plain = await app!.inject({ method: 'GET', url: BROWSER_WS_PATH });
    expect(plain.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('pairs, says who is connected, and unpairing drops the socket', async () => {
    const port = await start(true);
    expect((await app!.inject({ method: 'POST', url: '/api/browser/pairing-code', headers: auth })).statusCode).toBe(409);
    await setSwitch(true);
    const { code } = (await app!.inject({ method: 'POST', url: '/api/browser/pairing-code', headers: auth })).json();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

    const ext = await open(port);
    ext.ws.send(JSON.stringify({ type: 'pair', code, browser: 'Chrome' }));
    await vi.waitFor(() => expect(ext.frames[0]).toMatchObject({ type: 'paired' }));
    const token = ext.frames[0].token as string;

    const status = (await app!.inject({ method: 'GET', url: '/api/browser', headers: auth })).json();
    expect(status).toMatchObject({ enabled: true, pairings: [{ browser: 'Chrome', connected: true }] });

    // A token opens the socket, and nothing under /api.
    expect((await app!.inject({ method: 'GET', url: '/api/browser', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);

    const del = await app!.inject({ method: 'DELETE', url: `/api/browser/pairings/${status.pairings[0].id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    await vi.waitFor(() => expect(ext.closed()).toBe(BROWSER_CLOSE.unauthorized));

    const again = await open(port);
    again.ws.send(JSON.stringify({ type: 'hello', token, browser: 'Chrome' }));
    await vi.waitFor(() => expect(again.closed()).toBe(BROWSER_CLOSE.unauthorized));
  });

  it('closes with disabled while the switch is off, and turning it off drops the extension', async () => {
    const port = await start(true);
    const off = await open(port);
    await vi.waitFor(() => expect(off.closed()).toBe(BROWSER_CLOSE.disabled));

    await setSwitch(true);
    const { code } = (await app!.inject({ method: 'POST', url: '/api/browser/pairing-code', headers: auth })).json();
    const ext = await open(port, null);
    ext.ws.send(JSON.stringify({ type: 'pair', code, browser: 'Arc' }));
    await vi.waitFor(() => expect(ext.frames[0]).toMatchObject({ type: 'paired' }));
    await setSwitch(false);
    await vi.waitFor(() => expect(ext.closed()).toBe(BROWSER_CLOSE.disabled));
    expect((await app!.inject({ method: 'GET', url: '/api/browser', headers: auth })).json()).toMatchObject({ enabled: false });
  });

  it('refuses a malformed outcome and takes one for an event long gone', async () => {
    await start();
    const post = (payload: unknown) => app!.inject({ method: 'POST', url: '/api/browser/outcome', headers: auth, payload: payload as object });
    expect((await post({ eventId: 'e', delivered: 'yes' })).statusCode).toBe(400);
    expect((await post({ eventId: 'e', delivered: false, reason: 'no-session' })).statusCode).toBe(204);
  });
});
