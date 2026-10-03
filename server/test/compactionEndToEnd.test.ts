import { describe, it, expect, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { makeTmpDir } from './tmp.js';

/**
 * A failed compaction across the whole chain (spec
 * 2026-09-28-context-compaction-design § Failure, § Dev simulation): the
 * runner's status handling -> `compaction_failures` and the error log ->
 * `lastCompactionFailed` on the snapshot -> the mark merged into
 * `GET /messages` — and what clears it, including across a restart.
 */

/**
 * Fake SDK: every prompt runs a turn that ends with a `result`, and a prompt
 * of `/compact` fails its compaction inside that turn, the way the CLI does.
 */
function fakeQueryFn() {
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = options?.sessionId ?? options?.resume;
    async function* gen() {
      for await (const m of prompt) {
        const text: string = m.message.content.at(-1)?.text ?? '';
        yield {
          type: 'assistant', session_id: sid, parent_tool_use_id: null,
          message: { id: `a-${text}`, role: 'assistant', content: [{ type: 'text', text: `on it: ${text}` }] },
        };
        if (text.startsWith('/compact')) {
          yield { type: 'system', subtype: 'status', status: 'compacting', session_id: sid };
          yield {
            type: 'system', subtype: 'status', status: null, compact_result: 'failed',
            compact_error: 'API Error 529 · Overloaded', session_id: sid,
          };
        }
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    return gen() as any;
  };
  return fn;
}

function tempDirs() {
  const claudeDir = makeTmpDir('compaction-e2e');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  return { claudeDir, dbPath: join(claudeDir, 'index.db') };
}

async function sessionOf(app: any, id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });
  return res.json().session;
}

async function launch(app: any, prompt: string): Promise<string> {
  const created = await app.inject({
    method: 'POST', url: '/api/sessions',
    payload: { cwd: '/w', prompt, permissionMode: 'acceptEdits' },
  });
  return created.json().sessionId;
}

describe('a failed compaction, end to end', () => {
  it('is persisted, logged, marked on the snapshot, survives opening and a restart, and clears on the next turn', async () => {
    const dirs = tempDirs();
    let app = await buildServer({ ...dirs, queryFn: fakeQueryFn() as any });
    let sessionId: string;
    try {
      sessionId = await launch(app, '/compact');
      await vi.waitFor(async () => {
        expect((await sessionOf(app, sessionId))?.lastCompactionFailed).toEqual({ at: expect.any(Number) });
      }, { timeout: 3000 });

      const errors = (await app.inject({ method: 'GET', url: '/api/errors' })).json().errors;
      expect(errors).toContainEqual(
        expect.objectContaining({
          kind: 'compaction_failed', source: 'server', sessionId,
          message: 'Compaction failed: API Error 529 · Overloaded',
          context: expect.objectContaining({ trigger: 'manual', cwd: '/w' }),
        }),
      );

      // Opening the session reads its transcript; that fixes nothing.
      const messages = (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/messages` })).json()
        .messages;
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: 'compaction',
          compaction: expect.objectContaining({ outcome: 'failed', trigger: 'manual', error: 'API Error 529 · Overloaded' }),
        }),
      );
      expect((await sessionOf(app, sessionId)).lastCompactionFailed).not.toBeNull();
    } finally {
      await app.close();
    }

    // A restart keeps it: the row is the source.
    app = await buildServer({ ...dirs, queryFn: fakeQueryFn() as any });
    try {
      expect((await sessionOf(app, sessionId)).lastCompactionFailed).not.toBeNull();
      // The next turn — a revive here — retires it.
      await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/messages`, payload: { text: 'carry on' } });
      await vi.waitFor(async () => {
        expect((await sessionOf(app, sessionId)).lastCompactionFailed).toBeNull();
      }, { timeout: 3000 });
      // The mark itself stays in the transcript.
      const messages = (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/messages` })).json()
        .messages;
      expect(messages.filter((m: any) => m.role === 'compaction')).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe('the dev compaction simulation', () => {
  it('is not registered without the dev signal', async () => {
    const dirs = tempDirs();
    const app = await buildServer({ ...dirs, queryFn: fakeQueryFn() as any });
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/dev/sessions/any/simulate-compaction', payload: { outcome: 'failed', seconds: 0 },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("plays its outcomes through the runner's real handler", async () => {
    const dirs = tempDirs();
    const app = await buildServer({ ...dirs, queryFn: fakeQueryFn() as any, devTools: true });
    try {
      const sessionId = await launch(app, 'hello');
      await vi.waitFor(async () => expect((await sessionOf(app, sessionId))?.status).toBe('needs_input'));

      const bad = await app.inject({
        method: 'POST', url: `/api/dev/sessions/${sessionId}/simulate-compaction`, payload: { outcome: 'nope' },
      });
      expect(bad.statusCode).toBe(400);

      const res = await app.inject({
        method: 'POST', url: `/api/dev/sessions/${sessionId}/simulate-compaction`,
        payload: { outcome: 'failed_no_error', seconds: 0 },
      });
      expect(res.statusCode).toBe(202);
      // Only the real path persists and logs a failure.
      await vi.waitFor(async () => {
        expect((await sessionOf(app, sessionId)).lastCompactionFailed).not.toBeNull();
      }, { timeout: 3000 });
      const errors = (await app.inject({ method: 'GET', url: '/api/errors' })).json().errors;
      expect(errors).toContainEqual(
        expect.objectContaining({ kind: 'compaction_failed', message: 'Compaction failed (no reason given)' }),
      );

      // A success clears the failure, and the arc drains to its post_tokens.
      await app.inject({
        method: 'POST', url: `/api/dev/sessions/${sessionId}/simulate-compaction`,
        payload: { outcome: 'success', seconds: 0 },
      });
      await vi.waitFor(async () => {
        const session = await sessionOf(app, sessionId);
        expect(session.lastCompactionFailed).toBeNull();
        expect(session.contextUsedTokens).toBe(18_000);
      }, { timeout: 3000 });
      expect((await sessionOf(app, sessionId)).status).toBe('needs_input');

      const unknown = await app.inject({
        method: 'POST', url: '/api/dev/sessions/not-running/simulate-compaction', payload: { outcome: 'success' },
      });
      expect(unknown.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
