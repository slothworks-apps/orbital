import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';

/**
 * The chain only `index.ts` wires: a session whose SDK generator throws ->
 * `Runner.onError` -> `ErrorLog.record` -> `GET /api/errors`. The unit tests
 * each prove one link; this proves the reason a session died actually reaches
 * the browser, which is the whole point of
 * `docs/superpowers/specs/2026-09-17-error-surface-design.md`.
 */

function fakeQueryFnThrowing(message: string) {
  return ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = options?.sessionId ?? options?.resume;
    async function* gen() {
      for await (const _ of prompt) {
        yield { type: 'system', subtype: 'init', session_id: sid };
        throw new Error(message);
      }
    }
    return gen() as any;
  };
}

function tempClaudeDir() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-err-e2e-'));
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  return { claudeDir, dbPath: join(claudeDir, 'index.db') };
}

describe('a session that dies on its own, end to end', () => {
  let warn: any;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('records the real reason, with the session settings that produced it', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const app = await buildServer({
      claudeDir, dbPath, queryFn: fakeQueryFnThrowing('spawn claude ENOENT') as any,
    });
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: {
          cwd: '/w/x', prompt: 'go', permissionMode: 'bypassPermissions', model: 'opus',
        },
      });
      const { sessionId } = created.json();

      await vi.waitFor(async () => {
        const body = (await app.inject({ method: 'GET', url: '/api/errors' })).json();
        expect(body.errors).toHaveLength(1);
      }, { timeout: 3000 });

      const body = (await app.inject({ method: 'GET', url: '/api/errors' })).json();
      expect(body.errors[0]).toMatchObject({
        source: 'server',
        kind: 'session_failed',
        sessionId,
        message: 'spawn claude ENOENT',
        context: { cwd: '/w/x', permissionMode: 'bypassPermissions', model: 'opus' },
        seenAt: null,
      });
      // The stack rides along whole, which is the thing `console.warn` alone
      // was throwing away.
      expect(body.errors[0].detail).toContain('spawn claude ENOENT');
      expect(body.unseen).toBe(1);

      // The session still ends the ordinary way — no `failed` status exists.
      const session = (
        await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })
      ).json().session;
      expect(session.status).toBe('ended');
    } finally {
      await app.close();
    }
  });
});
