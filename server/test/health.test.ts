import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { settings } from '../src/db/schema.js';

/**
 * The desktop app probes 4737 before it does anything else: something that
 * answers as orbital is attached to, anything else is a foreign service and
 * gets left alone (spec 2026-09-16-electron-wrapper-design § 1). The CLI block
 * is what its missing-CLI dialog keys off. Both are a contract — the field
 * names here are load-bearing.
 */
function tempClaudeDir() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-health-'));
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  return { claudeDir, dbPath: join(claudeDir, 'index.db') };
}

describe('GET /api/health', () => {
  it('identifies the server as orbital and reports how the claude CLI was resolved', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const app = await buildServer({ claudeDir, dbPath, queryFn: (() => {}) as any });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.app).toBe('orbital');
      expect(['settings', 'path', 'bundled', 'missing']).toContain(body.claudeCli.source);
      expect(body.claudeCli).toHaveProperty('path');
      expect(body.claudeCli).toHaveProperty('version');
      // No staticDir: this is a dev server, and its `/` is a JSON 404. The
      // desktop app reads this to send its window to vite instead.
      expect(body.static).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('reports that it serves the web app when a staticDir is configured', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const staticDir = mkdtempSync(join(tmpdir(), 'orbital-health-dist-'));
    const app = await buildServer({ claudeDir, dbPath, queryFn: (() => {}) as any, staticDir });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json().static).toBe(true);
    } finally {
      await app.close();
    }
  });

  /**
   * Settings → General reads both of these (spec
   * 2026-09-21-settings-sections-design § 4). They are facts about how the
   * server started rather than settings, which is why they ride here — and
   * the names are as load-bearing as the CLI block above.
   */
  it('reports the paths it is actually using, not the defaults', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const app = await buildServer({ claudeDir, dbPath, queryFn: (() => {}) as any });
    try {
      const { paths } = (await app.inject({ method: 'GET', url: '/api/health' })).json();
      // The override this server was actually built with, so the row cannot
      // show `~/.claude` while the watcher reads somewhere else.
      expect(paths.claudeDir).toBe(claudeDir);
      expect(paths.dbPath).toBe(dbPath);
      expect(paths).toHaveProperty('dataDir');
    } finally {
      await app.close();
    }
  });

  it('reports which way sessions are billed', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const before = process.env.ORBITAL_USE_API_KEY;

    delete process.env.ORBITAL_USE_API_KEY;
    const subscription = await buildServer({ claudeDir, dbPath, queryFn: (() => {}) as any });
    try {
      expect((await subscription.inject({ method: 'GET', url: '/api/health' })).json().billing)
        .toBe('subscription');
    } finally {
      await subscription.close();
    }

    // The opt-in is the only thing that leaves ANTHROPIC_API_KEY in place, so
    // it is also the only thing that can make this say 'api-key'.
    process.env.ORBITAL_USE_API_KEY = '1';
    const apiKey = await buildServer({
      claudeDir, dbPath: join(claudeDir, 'index-2.db'), queryFn: (() => {}) as any,
    });
    try {
      expect((await apiKey.inject({ method: 'GET', url: '/api/health' })).json().billing)
        .toBe('api-key');
    } finally {
      await apiKey.close();
      if (before === undefined) delete process.env.ORBITAL_USE_API_KEY;
      else process.env.ORBITAL_USE_API_KEY = before;
    }
  });

  /**
   * The reason `openDb` moved above the path resolution in `buildServer`:
   * `claude_directory` lives in the table, so the table has to exist before
   * the question can be asked. Without the reorder this reads `~/.claude`.
   */
  it('watches the directory stored in the settings table', async () => {
    const stored = tempClaudeDir();
    const { dbPath } = tempClaudeDir();
    const seed = openDb(dbPath);
    seed
      .insert(settings)
      .values({ key: 'claude_directory', value: stored.claudeDir })
      .onConflictDoUpdate({ target: settings.key, set: { value: stored.claudeDir } })
      .run();
    seed.$client.close();

    const before = process.env.ORBITAL_CLAUDE_DIR;
    delete process.env.ORBITAL_CLAUDE_DIR;
    const app = await buildServer({ dbPath, queryFn: (() => {}) as any });
    try {
      const { paths } = (await app.inject({ method: 'GET', url: '/api/health' })).json();
      expect(paths.claudeDir).toBe(stored.claudeDir);
    } finally {
      await app.close();
      if (before === undefined) delete process.env.ORBITAL_CLAUDE_DIR;
      else process.env.ORBITAL_CLAUDE_DIR = before;
    }
  });

  it('is refused from a foreign Host, like every other route (I5)', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const app = await buildServer({ claudeDir, dbPath, queryFn: (() => {}) as any });
    try {
      const res = await app.inject({
        method: 'GET', url: '/api/health', headers: { host: 'evil.example.com' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
