import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';

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
