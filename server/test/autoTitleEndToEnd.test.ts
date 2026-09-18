import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';

/**
 * The chain only `index.ts` wires: a running session's messages ->
 * `SessionTitler.feed` -> a turn ending -> `considerTurnEnd` -> the session
 * row's new title. The unit tests prove each link; this proves a session
 * actually renames itself, which is the point of
 * `docs/superpowers/specs/2026-09-18-auto-title-design.md`.
 */

/** Fake SDK for the session itself: echoes each prompt, then ends the turn. */
function fakeSessionQueryFn() {
  return ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = options?.sessionId ?? options?.resume;
    async function* gen() {
      let announced = false;
      for await (const userMsg of prompt) {
        if (!announced) {
          announced = true;
          yield { type: 'system', subtype: 'init', session_id: sid };
        }
        const text = userMsg.message.content[0].text;
        yield {
          type: 'user', session_id: sid,
          message: { role: 'user', content: [{ type: 'text', text }] },
        };
        yield {
          type: 'assistant', session_id: sid,
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    return gen() as any;
  };
}

/** Fake SDK for the titler: one assistant message carrying the new name. */
function fakeTitleQueryFn(name: string) {
  return () => {
    async function* gen() {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: name }] } };
      yield { type: 'result', subtype: 'success' };
    }
    return gen();
  };
}

function tempClaudeDir() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-title-e2e-'));
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  return { claudeDir, dbPath: join(claudeDir, 'index.db') };
}

async function runSession(app: any, enabled: boolean) {
  await app.inject({
    method: 'PATCH', url: '/api/settings',
    payload: { auto_title_sessions: enabled ? 'true' : 'false' },
  });
  const created = await app.inject({
    method: 'POST', url: '/api/sessions',
    payload: { cwd: '/w/x', prompt: 'go', permissionMode: 'acceptEdits' },
  });
  const { sessionId } = created.json();
  for (const text of [
    'the space map zoom feels wrong',
    'planets are too small when zoomed out',
    'counter-zoom the bodies below the default',
  ]) {
    await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/messages`, payload: { text } });
  }
  return sessionId;
}

const titleOf = async (app: any, id: string) =>
  (await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json().session.title;

describe('a session naming itself, end to end', () => {
  it('renames the session once its subject has moved', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const app = await buildServer({
      claudeDir, dbPath,
      queryFn: fakeSessionQueryFn() as any,
      titleQueryFn: fakeTitleQueryFn('Space map counter-zoom') as any,
    });
    try {
      const sessionId = await runSession(app, true);
      await vi.waitFor(async () => {
        expect(await titleOf(app, sessionId)).toBe('Space map counter-zoom');
      });
    } finally {
      await app.close();
    }
  });

  it('leaves the title alone while the setting is off', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const titleQueryFn = vi.fn(fakeTitleQueryFn('Space map counter-zoom'));
    const app = await buildServer({
      claudeDir, dbPath,
      queryFn: fakeSessionQueryFn() as any,
      titleQueryFn: titleQueryFn as any,
    });
    try {
      const sessionId = await runSession(app, false);
      // The turns have to have actually run before "nothing happened" means
      // anything: a session is back to `needs_input` once its last turn ended.
      await vi.waitFor(async () => {
        const { session } = (
          await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })
        ).json();
        expect(session.status).toBe('needs_input');
      });
      expect(titleQueryFn).not.toHaveBeenCalled();
      expect(await titleOf(app, sessionId)).toBe('');
    } finally {
      await app.close();
    }
  });
});
