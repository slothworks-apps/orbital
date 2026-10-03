import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { makeTmpDir } from './tmp.js';

/**
 * The packaged window loads `http://127.0.0.1:4737`, so the server serves the
 * built frontend same-origin (spec 2026-09-16-electron-wrapper-design § 1) —
 * which is what keeps `isAllowedHost` and `isAllowedWsOrigin` working as
 * written. Dev and the rest of the suite pass no `staticDir` and must see
 * exactly today's behaviour.
 */
function tempClaudeDir() {
  const claudeDir = makeTmpDir('static');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  return { claudeDir, dbPath: join(claudeDir, 'index.db') };
}

function tempWebDist() {
  const dir = makeTmpDir('dist');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html>orbital app</html>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")');
  return dir;
}

describe('serving the built frontend', () => {
  it('serves index.html, its assets, and falls back to index.html for path routes', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const app = await buildServer({
      claudeDir, dbPath, queryFn: (() => {}) as any, staticDir: tempWebDist(),
    });
    try {
      const index = await app.inject({ method: 'GET', url: '/' });
      expect(index.statusCode).toBe(200);
      expect(index.body).toContain('orbital app');

      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain('console.log');

      // A real path route (`/sandbox` and friends) refreshed in the browser:
      // no such file exists, and the SPA has to get its shell anyway.
      const route = await app.inject({ method: 'GET', url: '/stats' });
      expect(route.statusCode).toBe(200);
      expect(route.body).toContain('orbital app');

      // The API must never be swallowed by that fallback.
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json().app).toBe('orbital');

      const missing = await app.inject({ method: 'POST', url: '/api/nope' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: 'not found' });
    } finally {
      await app.close();
    }
  });

  it('serves nothing when no staticDir is configured', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const app = await buildServer({ claudeDir, dbPath, queryFn: (() => {}) as any });
    try {
      expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
