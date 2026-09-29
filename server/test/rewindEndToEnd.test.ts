import { describe, it, expect, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { pendingRewinds, rewinds, sessions } from '../src/db/schema.js';

/**
 * Rewind across the whole server (spec 2026-09-29-rewind-design § API,
 * § Runner): the routes against a real database and transcript file, and the
 * send path against a fake SDK that answers a truncating resume the way the
 * CLI was verified to — writing the new prompt under the uuid Orbital set,
 * parented to the fork — or refuses it.
 */

type Entry = Record<string, unknown>;
const prompt = (uuid: string, parentUuid: string | null, text: string): Entry => ({
  type: 'user', uuid, parentUuid, timestamp: new Date().toISOString(), message: { role: 'user', content: text },
});
const says = (uuid: string, parentUuid: string, text: string): Entry => ({
  type: 'assistant', uuid, parentUuid, timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const hook = (uuid: string, parentUuid: string): Entry => ({
  type: 'system', subtype: 'stop_hook_summary', uuid, parentUuid,
});

/** Three answered turns; `s1` and `s2` are the fork points of `u2` and `u3`. */
const THREE_TURNS = [
  prompt('u1', null, 'first'), says('a1', 'u1', 'one'), hook('s1', 'a1'),
  prompt('u2', 's1', 'second'), says('a2', 'u2', 'two'), hook('s2', 'a2'),
  prompt('u3', 's2', 'third'), says('a3', 'u3', 'three'),
];

const REFUSAL = 'Resume rejected by --resume-drops-turn: a user entry not attributable to the declared turn';

type Mode = 'answer' | 'refuse' | 'stall' | 'wedge';

/**
 * Fake SDK. `answer` writes each prompt and its reply to the transcript as
 * the CLI would, `refuse` answers a truncating resume with the CLI's refusal
 * (result, then the iterator throws), `stall` leaves the turn running until
 * the input closes, `wedge` never exits at all.
 */
function fakeSdk(file: string, mode: () => Mode) {
  const calls: Array<Record<string, any>> = [];
  const prompts: any[] = [];
  let last = 'a3';
  let exited = 0;
  const fn = ({ prompt: input, options }: { prompt: AsyncIterable<any>; options: any }) => {
    calls.push(options);
    const sid = options.sessionId ?? options.resume;
    const behaviour = mode();
    async function* gen() {
      try {
        for await (const msg of input) {
          prompts.push(msg);
          if (behaviour === 'refuse' && options.resumeSessionAt) {
            yield { type: 'result', subtype: 'error_during_execution', session_id: sid, errors: [REFUSAL] };
            throw new Error(REFUSAL);
          }
          yield { type: 'system', subtype: 'init', session_id: sid };
          if (behaviour === 'stall') continue;
          if (behaviour === 'wedge') await new Promise<void>(() => {});
          const text = msg.message.content.at(-1).text as string;
          const parent = options.resumeSessionAt && prompts.length === 1 ? options.resumeSessionAt : last;
          const reply = `r-${prompts.length}`;
          appendFileSync(file, `${JSON.stringify(prompt(msg.uuid, parent, text))}\n`);
          appendFileSync(file, `${JSON.stringify(says(reply, msg.uuid, `re: ${text}`))}\n`);
          last = reply;
          yield {
            type: 'assistant', uuid: reply, session_id: sid, parent_tool_use_id: null,
            message: { role: 'assistant', content: [{ type: 'text', text: `re: ${text}` }] },
          };
          yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
        }
      } finally {
        exited += 1;
      }
    }
    return gen() as any;
  };
  return { fn, calls, prompts, exited: () => exited };
}

async function setup(opts: { mode?: Mode; terminal?: boolean; rewindStopTimeoutMs?: number } = {}) {
  const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-rewind-e2e-'));
  mkdirSync(join(claudeDir, 'projects', 'p'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  const id = randomUUID();
  const file = join(claudeDir, 'projects', 'p', `${id}.jsonl`);
  writeFileSync(file, THREE_TURNS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const dbPath = join(claudeDir, 'index.db');
  const seed = openDb(dbPath);
  seed.insert(sessions).values({
    id, projectDir: 'p', cwd: claudeDir, source: 'web', lastAt: Date.now(), contextUsedTokens: 5_000,
  }).run();
  seed.$client.close();
  if (opts.terminal) {
    writeFileSync(join(claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id }));
  }
  const sdk = fakeSdk(file, () => opts.mode ?? 'answer');
  const app = await buildServer({
    claudeDir, dbPath, queryFn: sdk.fn as any, rewindStopTimeoutMs: opts.rewindStopTimeoutMs,
  });
  const db = openDb(dbPath);
  const session = async () =>
    (await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json().session;
  const texts = async () =>
    ((await app.inject({ method: 'GET', url: `/api/sessions/${id}/messages` })).json().messages as any[])
      .map((m) => (m.role === 'rewind' ? `— ${m.rewind.hiddenCount ?? 'terminal'}` : m.text));
  const rewind = (uuid: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST', url: `/api/sessions/${id}/rewind`,
      payload: { uuid, hiddenCount: 2, draft: 'my draft', ...extra },
    });
  const send = (text: string) =>
    app.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, payload: { text } });
  const close = async () => {
    await app.close();
    db.$client.close();
  };
  return {
    app, db, id, file, sdk, session, texts, rewind, send, close,
  };
}

const pendingRow = (db: ReturnType<typeof openDb>, id: string) =>
  db.select().from(pendingRewinds).where(eq(pendingRewinds.sessionId, id)).get();
const sentRows = (db: ReturnType<typeof openDb>, id: string) =>
  db.select().from(rewinds).where(eq(rewinds.sessionId, id)).all();

/** A real socket on `session:<id>`, collecting every frame. */
async function listen(app: Awaited<ReturnType<typeof buildServer>>, id: string) {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: any[] = [];
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
  ws.send(JSON.stringify({ type: 'subscribe', topic: `session:${id}` }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { frames, close: () => ws.close() };
}

describe('POST /api/sessions/:id/rewind', () => {
  it('refuses a malformed body, an unknown session and a message that is no target', async () => {
    const t = await setup();
    try {
      expect((await t.rewind('u3', { hiddenCount: -1 })).statusCode).toBe(400);
      expect((await t.rewind('u3', { draft: 5 })).statusCode).toBe(400);
      const unknown = await t.app.inject({
        method: 'POST', url: '/api/sessions/nope/rewind', payload: { uuid: 'u3', hiddenCount: 1 },
      });
      expect(unknown.statusCode).toBe(404);
      // The first prompt has no conversation before it; `a2` is not the user's.
      for (const uuid of ['u1', 'a2', 'missing']) {
        const res = await t.rewind(uuid);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: 'not_rewindable' });
      }
      expect(pendingRow(t.db, t.id)).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it('refuses a session a terminal holds', async () => {
    const t = await setup({ terminal: true });
    try {
      const res = await t.rewind('u3');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'terminal_session' });
    } finally {
      await t.close();
    }
  });

  it('holds the rewind pending: cut transcript, waiting for input, and a second pick refused', async () => {
    const t = await setup();
    try {
      const res = await t.rewind('u3');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ text: 'third' });
      expect(pendingRow(t.db, t.id)).toMatchObject({ targetUuid: 'u3', forkUuid: 's2', dropsTurn: 'u3' });
      const session = await t.session();
      expect(session.rewindPending).toEqual({ hiddenCount: 2, text: 'third' });
      expect(session.status).toBe('needs_input');
      expect(await t.texts()).toEqual(['first', 'one', 'second', 'two']);

      const again = await t.rewind('u2');
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: 'rewind_pending' });
    } finally {
      await t.close();
    }
  });

  it('marks the pickable messages on the wire', async () => {
    const t = await setup();
    try {
      const messages = (await t.app.inject({ method: 'GET', url: `/api/sessions/${t.id}/messages` })).json().messages;
      expect(messages.filter((m: any) => m.rewindable).map((m: any) => m.uuid)).toEqual(['u2', 'u3']);
      expect(messages.every((m: any) => typeof m.uuid === 'string')).toBe(true);
    } finally {
      await t.close();
    }
  });

  it('stops a live session and waits for its process before storing the rewind', async () => {
    const t = await setup({ mode: 'stall' });
    try {
      await t.send('keep going');
      await vi.waitFor(async () => expect((await t.session()).status).toBe('working'));
      const res = await t.rewind('u2');
      expect(res.statusCode).toBe(200);
      expect(t.sdk.exited()).toBe(1);
      const session = await t.session();
      expect(session.status).toBe('needs_input');
      expect(session.rewindPending).toEqual({ hiddenCount: 2, text: 'second' });
    } finally {
      await t.close();
    }
  });

  it('fails visibly when the process will not exit, and stores nothing', async () => {
    const t = await setup({ mode: 'wedge', rewindStopTimeoutMs: 200 });
    try {
      await t.send('keep going');
      await vi.waitFor(async () => expect((await t.session()).status).toBe('working'));
      const res = await t.rewind('u2');
      expect(res.statusCode).toBe(504);
      expect(res.json()).toMatchObject({ error: 'stop_timeout' });
      expect(pendingRow(t.db, t.id)).toBeUndefined();
      const errors = (await t.app.inject({ method: 'GET', url: '/api/errors' })).json().errors;
      expect(errors.map((e: any) => e.kind)).toContain('rewind_failed');
    } finally {
      await t.close();
    }
  });
});

describe('DELETE /api/sessions/:id/rewind', () => {
  it('brings the hidden messages back and hands back the draft from before the pick', async () => {
    const t = await setup();
    try {
      await t.rewind('u3');
      const res = await t.app.inject({ method: 'DELETE', url: `/api/sessions/${t.id}/rewind` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ draft: 'my draft' });
      expect((await t.session()).rewindPending).toBeNull();
      expect((await t.session()).status).toBe('idle');
      expect(await t.texts()).toEqual(['first', 'one', 'second', 'two', 'third', 'three']);

      const none = await t.app.inject({ method: 'DELETE', url: `/api/sessions/${t.id}/rewind` });
      expect(none.statusCode).toBe(404);
      expect(none.json()).toEqual({ error: 'no_rewind_pending' });
    } finally {
      await t.close();
    }
  });
});

describe('sending a pending rewind', () => {
  it('resumes at the fork, guarded when the target is the newest turn, and records the rewind', async () => {
    const t = await setup();
    try {
      await t.rewind('u3');
      const res = await t.send('third, edited');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({ ok: true, revived: true, uuid: expect.any(String), rewind: true });
      expect(t.sdk.calls[0]).toMatchObject({ resume: t.id, resumeSessionAt: 's2', resumeDropsTurn: 'u3' });
      // The uuid the response names is the one the prompt went out under.
      expect(t.sdk.prompts[0].uuid).toBe(body.uuid);

      await vi.waitFor(() => expect(sentRows(t.db, t.id)).toHaveLength(1));
      expect(pendingRow(t.db, t.id)).toBeUndefined();
      expect(sentRows(t.db, t.id)[0]).toMatchObject({ forkUuid: 's2', targetUuid: 'u3', hiddenCount: 2 });
      await vi.waitFor(async () => expect((await t.session()).status).toBe('needs_input'));
      const session = await t.session();
      expect(session.contextUsedTokens).toBeNull();
      expect(session.rewindPending).toBeNull();
      expect(await t.texts()).toEqual(['first', 'one', 'second', 'two', '— 2', 'third, edited', 're: third, edited']);
    } finally {
      await t.close();
    }
  });

  it('leaves the guard off a rewind deeper than the newest turn', async () => {
    const t = await setup();
    try {
      await t.rewind('u2');
      await t.send('second, edited');
      expect(t.sdk.calls[0].resumeSessionAt).toBe('s1');
      expect(t.sdk.calls[0]).not.toHaveProperty('resumeDropsTurn');
      await vi.waitFor(() => expect(sentRows(t.db, t.id)).toHaveLength(1));
    } finally {
      await t.close();
    }
  });

  it('on a refusal sends nothing, restores the transcript, says so and logs what was restored', async () => {
    const t = await setup({ mode: 'refuse' });
    const socket = await listen(t.app, t.id);
    try {
      await t.rewind('u3');
      const before = readFileSync(t.file, 'utf8');
      const res = await t.send('third, edited');
      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(socket.frames.some((f) => f.event === 'rewind_refused')).toBe(true));
      expect(socket.frames.find((f) => f.event === 'rewind_refused')).toEqual({
        topic: `session:${t.id}`, event: 'rewind_refused', message: REFUSAL, hiddenCount: 2,
      });
      expect(socket.frames.some((f) => f.event === 'transcript_reset')).toBe(true);

      expect(pendingRow(t.db, t.id)).toBeUndefined();
      expect(sentRows(t.db, t.id)).toEqual([]);
      expect(readFileSync(t.file, 'utf8')).toBe(before);
      expect(await t.texts()).toEqual(['first', 'one', 'second', 'two', 'third', 'three']);
      await vi.waitFor(async () => expect((await t.session()).status).toBe('idle'));

      const errors = (await t.app.inject({ method: 'GET', url: '/api/errors' })).json().errors;
      expect(errors.map((e: any) => e.kind)).toEqual(['rewind_refused']);
      expect(errors[0].message).toContain('2 hidden messages restored');
      expect(errors[0].detail).toBe(REFUSAL);
    } finally {
      socket.close();
      await t.close();
    }
  });
});

describe('the rest of the send path', () => {
  it('never delivers `/rewind` to the agent', async () => {
    const t = await setup();
    try {
      const res = await t.send(' /rewind ');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'local_command' });
      expect(t.sdk.calls).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it('answers an ordinary send with the uuid its turn is written under', async () => {
    const t = await setup();
    try {
      const res = await t.send('fourth');
      expect(res.json()).toEqual({ ok: true, revived: true, uuid: expect.any(String) });
      expect(t.sdk.prompts[0].uuid).toBe(res.json().uuid);
      expect(t.sdk.calls[0]).not.toHaveProperty('resumeSessionAt');
    } finally {
      await t.close();
    }
  });

  it('drops a pending rewind once a terminal takes the session', async () => {
    const t = await setup();
    try {
      await t.rewind('u3');
      // The registry hears the terminal through a directory watch, and a watch
      // opened a moment ago can miss a write. Each try writes the file again,
      // changed, so a missed event is followed by another.
      let tick = 0;
      await vi.waitFor(() => {
        writeFileSync(
          join(t.file, '..', '..', '..', 'sessions', `${process.pid}.json`),
          JSON.stringify({ pid: process.pid, sessionId: t.id, updatedAt: ++tick }),
        );
        expect(pendingRow(t.db, t.id)).toBeUndefined();
      }, { timeout: 10_000, interval: 500 });
    } finally {
      await t.close();
    }
  });
});
