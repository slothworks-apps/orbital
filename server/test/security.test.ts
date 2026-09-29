import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, DEV_WEB_PORT, isAllowedWsOrigin, isAllowedHost } from '../src/index.js';
import { CONFIG } from '../src/config.js';

describe('isAllowedWsOrigin (C2)', () => {
  it('allows an absent Origin (non-browser clients, tests)', () => {
    expect(isAllowedWsOrigin(undefined, CONFIG.port)).toBe(true);
    expect(isAllowedWsOrigin(null, CONFIG.port)).toBe(true);
  });
  it('allows our own dev/prod origins', () => {
    expect(isAllowedWsOrigin(`http://127.0.0.1:${CONFIG.port}`, CONFIG.port)).toBe(true);
    expect(isAllowedWsOrigin(`http://localhost:${CONFIG.port}`, CONFIG.port)).toBe(true);
    expect(isAllowedWsOrigin(`http://127.0.0.1:${DEV_WEB_PORT}`, CONFIG.port)).toBe(true);
    expect(isAllowedWsOrigin(`http://localhost:${DEV_WEB_PORT}`, CONFIG.port)).toBe(true);
  });
  it('rejects a foreign origin', () => {
    expect(isAllowedWsOrigin('http://evil.example', CONFIG.port)).toBe(false);
    // Vite's default port belongs to other projects' dev servers.
    expect(isAllowedWsOrigin('http://localhost:5173', CONFIG.port)).toBe(false);
    expect(isAllowedWsOrigin(`https://localhost:${DEV_WEB_PORT}`, CONFIG.port)).toBe(false); // wrong scheme
  });
});

describe('isAllowedHost (I5)', () => {
  it('allows an absent Host', () => {
    expect(isAllowedHost(undefined)).toBe(true);
  });
  it('allows localhost/127.0.0.1 regardless of port', () => {
    expect(isAllowedHost('localhost:80')).toBe(true); // fastify inject() default
    expect(isAllowedHost(`127.0.0.1:${CONFIG.port}`)).toBe(true);
    expect(isAllowedHost('localhost')).toBe(true);
  });
  it('rejects a foreign hostname', () => {
    expect(isAllowedHost('evil.com')).toBe(false);
    expect(isAllowedHost('evil.com:80')).toBe(false);
  });
});

describe('server integration: origin + host guards', () => {
  async function makeApp() {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-security-'));
    return buildServer({ dbPath: join(dir, 'index.db'), claudeDir: dir });
  }

  it('rejects a /ws upgrade from an evil Origin with 403', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/ws',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        origin: 'http://evil.example',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('does not reject a /ws upgrade with no Origin header with 403', async () => {
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
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });

  it('rejects a REST request with a foreign Host header with 403', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/sessions', headers: { host: 'evil.com' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('does not reject normal inject requests (default Host) with 403', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
