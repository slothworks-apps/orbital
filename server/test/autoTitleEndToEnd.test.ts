import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { makeTmpDir } from './tmp.js';

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
  const claudeDir = makeTmpDir('title-e2e');
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

/**
 * The other half of the same spec: the name regenerated because someone asked
 * for it. Worth its own end-to-end coverage because the interesting cases are
 * exactly the ones the automatic path cannot reach — a terminal session the
 * Runner never owned, with the setting off and a name a human typed.
 */

/** A terminal session as `~/.claude` leaves one: a transcript and nothing else. */
function writeTerminalTranscript(claudeDir: string, id: string, texts: string[]) {
  const pdir = join(claudeDir, 'projects', '-Users-tomin-Projects-slothworks-orbital');
  mkdirSync(pdir, { recursive: true });
  const entries = texts.map((text, i) => ({
    type: 'user',
    uuid: `u${i}`,
    timestamp: `2026-09-01T10:0${i}:00.000Z`,
    cwd: '/Users/tomin/Projects/slothworks/orbital',
    message: { role: 'user', content: text },
  }));
  writeFileSync(join(pdir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n'));
}

const TERMINAL_ID = '11111111-2222-4333-8444-555555555555';

describe('renaming a session on demand', () => {
  it('names a terminal session with the setting off and a title a human typed', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    writeTerminalTranscript(claudeDir, TERMINAL_ID, [
      'the space map zoom feels wrong',
      'planets are too small when zoomed out',
    ]);
    const app = await buildServer({
      claudeDir, dbPath,
      titleQueryFn: fakeTitleQueryFn('Space map counter-zoom') as any,
    });
    try {
      await app.inject({
        method: 'PATCH', url: '/api/settings',
        payload: { auto_title_sessions: 'false' },
      });
      await app.inject({
        method: 'PATCH', url: `/api/sessions/${TERMINAL_ID}`,
        payload: { title: 'Something I typed' },
      });

      const res = await app.inject({ method: 'POST', url: `/api/sessions/${TERMINAL_ID}/retitle` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ title: 'Space map counter-zoom', changed: true });
      expect(await titleOf(app, TERMINAL_ID)).toBe('Space map counter-zoom');
    } finally {
      await app.close();
    }
  });

  it('keeps the name when the model answers KEEP, and says so', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    writeTerminalTranscript(claudeDir, TERMINAL_ID, ['the space map zoom feels wrong']);
    const app = await buildServer({
      claudeDir, dbPath, titleQueryFn: fakeTitleQueryFn('KEEP') as any,
    });
    try {
      await app.inject({
        method: 'PATCH', url: `/api/sessions/${TERMINAL_ID}`,
        payload: { title: 'Something I typed' },
      });

      const res = await app.inject({ method: 'POST', url: `/api/sessions/${TERMINAL_ID}/retitle` });

      expect(res.json()).toMatchObject({ title: 'Something I typed', changed: false });
      expect(await titleOf(app, TERMINAL_ID)).toBe('Something I typed');
    } finally {
      await app.close();
    }
  });

  it('404s on a session that does not exist', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const app = await buildServer({ claudeDir, dbPath });
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/sessions/99999999-2222-4333-8444-555555555555/retitle',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('refuses a session with nothing written yet rather than naming an empty transcript', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const titleQueryFn = vi.fn(fakeTitleQueryFn('Space map counter-zoom'));
    const app = await buildServer({
      claudeDir, dbPath,
      queryFn: fakeSessionQueryFn() as any,
      titleQueryFn: titleQueryFn as any,
    });
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: { cwd: '/w/x', prompt: 'go', permissionMode: 'acceptEdits' },
      });
      const { sessionId } = created.json();

      const res = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/retitle` });

      expect(res.statusCode).toBe(409);
      expect(titleQueryFn).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
