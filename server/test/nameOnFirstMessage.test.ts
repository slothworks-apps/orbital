import { describe, it, expect, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { makeTmpDir } from './tmp.js';

/**
 * A session Orbital starts is named once, from its first message (spec
 * 2026-10-21-name-on-first-message-design). End to end, because what matters
 * is which route calls the titler, and that a name typed meanwhile wins.
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
        yield { type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'text', text }] } };
        yield { type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    return gen() as any;
  };
}

/** Fake SDK for the titler: answers `name` once `gate` resolves. */
function fakeTitleQueryFn(name: string, gate: Promise<void> = Promise.resolve()) {
  return vi.fn((_args: { prompt: string; options: Record<string, unknown> }) => {
    async function* gen() {
      await gate;
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: name }] } };
      yield { type: 'result', subtype: 'success' };
    }
    return gen();
  });
}

async function serverWith(titleQueryFn: ReturnType<typeof fakeTitleQueryFn>) {
  const claudeDir = makeTmpDir('first-title');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  return buildServer({
    claudeDir, dbPath: join(claudeDir, 'index.db'),
    queryFn: fakeSessionQueryFn() as any,
    titleQueryFn: titleQueryFn as any,
  });
}

const sessionOf = async (app: any, id: string) =>
  (await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json().session;

const launch = async (app: any, prompt: string) =>
  (await app.inject({
    method: 'POST', url: '/api/sessions',
    payload: { cwd: '/w/x', prompt, permissionMode: 'acceptEdits' },
  })).json().sessionId as string;

describe('naming a session from its first message', () => {
  it('names a session launched with a prompt, as a model-made name', async () => {
    const titleQueryFn = fakeTitleQueryFn('Map zoom fix');
    const app = await serverWith(titleQueryFn);
    try {
      const id = await launch(app, 'the planets are too small when zoomed out');

      await vi.waitFor(async () => expect((await sessionOf(app, id)).title).toBe('Map zoom fix'));
      expect(titleQueryFn.mock.calls[0][0].prompt).toBe('the planets are too small when zoomed out');
    } finally {
      await app.close();
    }
  });

  it('names a session that started empty at its first message, and never at a later one', async () => {
    const titleQueryFn = fakeTitleQueryFn('Map zoom fix');
    const app = await serverWith(titleQueryFn);
    try {
      const id = await launch(app, '');
      expect(titleQueryFn).not.toHaveBeenCalled();

      await app.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, payload: { text: 'fix the zoom' } });
      await vi.waitFor(async () => expect((await sessionOf(app, id)).title).toBe('Map zoom fix'));

      await app.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, payload: { text: 'and the labels' } });
      expect(titleQueryFn).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('does nothing with the setting off', async () => {
    const titleQueryFn = fakeTitleQueryFn('Map zoom fix');
    const app = await serverWith(titleQueryFn);
    try {
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { name_sessions_automatically: 'false' } });
      await launch(app, 'fix the zoom');
      expect(titleQueryFn).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('keeps a name typed while the model was still answering', async () => {
    let release!: () => void;
    const titleQueryFn = fakeTitleQueryFn('Map zoom fix', new Promise((r) => { release = r; }));
    const app = await serverWith(titleQueryFn);
    try {
      const id = await launch(app, 'fix the zoom');
      await vi.waitFor(() => expect(titleQueryFn).toHaveBeenCalled());
      await app.inject({ method: 'PATCH', url: `/api/sessions/${id}`, payload: { title: 'Mine' } });

      release();
      // Let the titler's reply land before reading.
      await new Promise((r) => setTimeout(r, 20));
      expect((await sessionOf(app, id)).title).toBe('Mine');
    } finally {
      await app.close();
    }
  });
});
