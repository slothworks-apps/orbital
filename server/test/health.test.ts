import { describe, it, expect } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { settings } from '../src/db/schema.js';
import { makeTmpDir } from './tmp.js';

/**
 * The desktop app probes 4737 before it does anything else: something that
 * answers as orbital is attached to, anything else is a foreign service and
 * gets left alone (spec 2026-09-16-electron-wrapper-design § 1). The CLI block
 * is what its missing-CLI dialog keys off. Both are a contract — the field
 * names here are load-bearing.
 */
function tempClaudeDir() {
  const claudeDir = makeTmpDir('health');
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
    const staticDir = makeTmpDir('health-dist');
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
      expect(paths.claudeDirs).toEqual([{ id: 1, path: claudeDir }]);
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
   * An install from before more than one directory keeps watching what it
   * watched: row 1 is seeded from the old `claude_directory` row at the first
   * boot (spec 2026-10-04-multiple-claude-directories-design § 1). Without it
   * this reads `~/.claude`.
   */
  it('seeds the first directory from the retired claude_directory setting', async () => {
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
      expect(paths.claudeDirs).toEqual([{ id: 1, path: stored.claudeDir }]);
      // Migrated into row 1, then dropped: nothing reads it any more.
      expect((await app.inject({ method: 'GET', url: '/api/settings' })).json()).not.toHaveProperty('claude_directory');
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

  /**
   * The desktop app reads these two before it attaches: a server some desktop
   * app forked, whose parent is gone, is an orphan it replaces; one of another
   * version it refuses (desktop `decideAttach`).
   */
  it('names its version and the desktop app that forked it, and neither when started by hand', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const before = { version: process.env.ORBITAL_VERSION, parent: process.env.ORBITAL_PARENT_PID };
    const restore = () => {
      for (const [key, value] of [['ORBITAL_VERSION', before.version], ['ORBITAL_PARENT_PID', before.parent]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };

    delete process.env.ORBITAL_VERSION;
    delete process.env.ORBITAL_PARENT_PID;
    const byHand = await buildServer({ claudeDir, dbPath, queryFn: (() => {}) as any });
    try {
      const body = (await byHand.inject({ method: 'GET', url: '/api/health' })).json();
      expect(body.version).toBeNull();
      expect(body.desktop).toBeNull();
    } finally {
      await byHand.close();
    }

    process.env.ORBITAL_VERSION = '9.8.7';
    process.env.ORBITAL_PARENT_PID = '4242';
    const forked = await buildServer({
      claudeDir, dbPath: join(claudeDir, 'index-2.db'), queryFn: (() => {}) as any,
    });
    try {
      const body = (await forked.inject({ method: 'GET', url: '/api/health' })).json();
      expect(body.version).toBe('9.8.7');
      expect(body.desktop).toEqual({ pid: process.pid, parentPid: 4242 });
    } finally {
      await forked.close();
      restore();
    }
  });
});
