import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { indexProjectsSliced } from '../src/indexer/indexer.js';
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

/**
 * The first index pass on a long history takes tens of seconds. Run while
 * the plugins were still loading, it held the event loop past Fastify's
 * plugin timeout and the boot failed on `@fastify/static` (fix
 * the-first-index-pass-timed-out-the-static-plugin). The pass now
 * waits for the server to be ready and must not keep it from answering.
 */
describe('the first index pass with the built frontend', () => {
  it('starts after the server is ready, lets it answer, and still indexes everything', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const fixture = readFileSync(join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'), 'utf8');
    for (let p = 0; p < 3; p++) {
      const project = join(claudeDir, 'projects', `proj-${p}`);
      mkdirSync(project, { recursive: true });
      for (let s = 0; s < 4; s++) writeFileSync(join(project, `s-${p}-${s}.jsonl`), fixture);
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const app = await buildServer({
      claudeDir, dbPath, queryFn: (() => {}) as any, staticDir: tempWebDist(),
      // One transcript per slice, behind a gate the test opens.
      indexProjectsSliced: async (db, projectsDir, onStats, owner, signal) => {
        calls++;
        await held;
        return indexProjectsSliced(db, projectsDir, onStats, owner, signal, 0);
      },
    });
    try {
      expect(calls).toBe(0);
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as AddressInfo;
      const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);

      const health = await get('/api/health');
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ app: 'orbital', static: true });
      expect(calls).toBe(1);
      expect((await (await get('/api/sessions')).json()).sessions).toHaveLength(0);

      release();
      await vi.waitFor(async () => {
        expect((await (await get('/api/sessions')).json()).sessions).toHaveLength(12);
      });
    } finally {
      release();
      await app.close();
    }
  });
});
