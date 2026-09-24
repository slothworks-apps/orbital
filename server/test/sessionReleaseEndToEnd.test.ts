import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { sessions } from '../src/db/schema.js';

/**
 * What happens to an Orbital session when its `claude` process goes away,
 * across the whole chain (spec 2026-09-24-sessions-end-only-by-hand-design
 * § 1, § 2, § 5). Only the user ends a session; a process that stops, exits
 * or dies with the server leaves it `idle`, and the next message revives it.
 *
 * `app.close()` is the kill. It disposes the Runner's timers and never
 * reaches the release, which is exactly what `tsx watch` does to a running
 * server — the `runner_status` claim survives because nothing was given the
 * chance to clear it.
 */

type QueryFn = (args: { prompt: AsyncIterable<any>; options: any }) => any;

/** Fake SDK that completes each turn, the way a healthy session behaves. */
function fakeQueryFn(): QueryFn {
  return ({ prompt, options }) => {
    const sid = options?.sessionId ?? options?.resume;
    async function* gen() {
      for await (const _ of prompt) {
        yield { type: 'system', subtype: 'init', session_id: sid };
        yield {
          type: 'assistant', session_id: sid, parent_tool_use_id: null,
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    return gen() as any;
  };
}

/** Fake SDK whose first turn never finishes — a session caught mid-work. */
function fakeQueryFnStalling(): QueryFn {
  return ({ prompt, options }) => {
    const sid = options?.sessionId ?? options?.resume;
    async function* gen() {
      for await (const _ of prompt) {
        yield { type: 'system', subtype: 'init', session_id: sid };
        // No `result`: the turn is still running when the server dies.
        await new Promise<void>(() => {});
      }
    }
    return gen() as any;
  };
}

/** Fake SDK whose CLI answers one turn and then exits on its own. */
function fakeQueryFnSelfExiting(): QueryFn {
  return ({ prompt, options }) => {
    const sid = options?.sessionId ?? options?.resume;
    async function* gen() {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: 'system', subtype: 'init', session_id: sid };
      yield {
        type: 'assistant', session_id: sid, parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'bye' }] },
      };
      yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
    }
    return gen() as any;
  };
}

function tempClaudeDir() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-release-e2e-'));
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  return { claudeDir, dbPath: join(claudeDir, 'index.db'), cwd: claudeDir };
}

async function sessionOf(app: any, id: string) {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  return res.json().sessions.find((s: { id: string }) => s.id === id);
}

const statusIs = (app: any, id: string, status: string) =>
  vi.waitFor(async () => expect((await sessionOf(app, id))?.status).toBe(status), { timeout: 3000 });

/** Starts a session on one server, then kills that server mid-life. */
async function killWhileRunning(
  dir: { claudeDir: string; dbPath: string; cwd: string },
  queryFn: QueryFn,
  status: string,
) {
  const app = await buildServer({ ...dir, queryFn: queryFn as any });
  const created = await app.inject({
    method: 'POST', url: '/api/sessions',
    payload: { cwd: dir.cwd, prompt: 'go', permissionMode: 'acceptEdits' },
  });
  const { sessionId } = created.json();
  await statusIs(app, sessionId, status);
  await app.close();
  return sessionId as string;
}

function claimOf(dbPath: string, id: string) {
  const db = openDb(dbPath);
  const row = db.select({ runnerStatus: sessions.runnerStatus })
    .from(sessions).where(eq(sessions.id, id)).get();
  db.$client.close();
  return row?.runnerStatus;
}

describe('boot: sessions the previous server was running', () => {
  it('releases them without resuming anything', async () => {
    const dir = tempClaudeDir();
    const id = await killWhileRunning(dir, fakeQueryFn(), 'needs_input');
    expect(claimOf(dir.dbPath, id)).toBe('needs_input');

    const spawned = vi.fn(fakeQueryFn());
    const app = await buildServer({ ...dir, queryFn: spawned as any });
    try {
      const session = await sessionOf(app, id);
      expect(session?.status).toBe('idle');
      expect(session?.interruptedAt).toBeNull();
      expect(spawned).not.toHaveBeenCalled();
      expect(claimOf(dir.dbPath, id)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('marks a session that was cut off mid-turn as interrupted', async () => {
    const dir = tempClaudeDir();
    const id = await killWhileRunning(dir, fakeQueryFnStalling(), 'working');

    const app = await buildServer({ ...dir, queryFn: fakeQueryFn() as any });
    try {
      const session = await sessionOf(app, id);
      expect(session?.status).toBe('idle');
      expect(session?.interruptedAt).toEqual(expect.any(Number));
      expect(claimOf(dir.dbPath, id)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('clears the mark once the session runs a turn again', async () => {
    const dir = tempClaudeDir();
    const id = await killWhileRunning(dir, fakeQueryFnStalling(), 'working');

    const app = await buildServer({ ...dir, queryFn: fakeQueryFn() as any });
    try {
      expect((await sessionOf(app, id))?.interruptedAt).toEqual(expect.any(Number));
      const sent = await app.inject({
        method: 'POST', url: `/api/sessions/${id}/messages`, payload: { text: 'carry on' },
      });
      expect(sent.json()).toMatchObject({ revived: true });
      await vi.waitFor(async () => {
        expect((await sessionOf(app, id))?.interruptedAt).toBeNull();
      }, { timeout: 3000 });
    } finally {
      await app.close();
    }
  });

  it('leaves a session that ended on purpose ended', async () => {
    const dir = tempClaudeDir();
    const app1 = await buildServer({ ...dir, queryFn: fakeQueryFn() as any });
    const created = await app1.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: dir.cwd, prompt: 'go', permissionMode: 'acceptEdits' },
    });
    const { sessionId: id } = created.json();
    await statusIs(app1, id, 'needs_input');
    await app1.inject({ method: 'POST', url: `/api/sessions/${id}/clear`, payload: {} });
    await app1.close();

    const app = await buildServer({ ...dir, queryFn: fakeQueryFn() as any });
    try {
      expect((await sessionOf(app, id))?.status).toBe('ended');
    } finally {
      await app.close();
    }
  });
});

/**
 * One real socket on both topics a stop is announced on: `sessions` (the
 * map) and `session:<id>` (the selected session's panel). Collects the status
 * each frame carries about `id`, in order.
 */
async function watch(port: number, id: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const map: string[] = [];
  const panel: string[] = [];
  ws.onmessage = (e) => {
    const frame = JSON.parse(String(e.data));
    if (frame.topic === 'sessions' && frame.event === 'upsert' && frame.session?.id === id) {
      map.push(frame.session.status);
    }
    if (frame.topic === `session:${id}` && frame.event === 'status') panel.push(frame.status);
  };
  await new Promise<void>((resolve) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe', topic: 'sessions' }));
      ws.send(JSON.stringify({ type: 'subscribe', topic: `session:${id}` }));
      resolve();
    };
  });
  // Subscribing has no ack; give the frames time to land before anything
  // is published that they would miss.
  await new Promise((r) => setTimeout(r, 200));
  return { ws, map, panel };
}

describe('a stopped process, announced', () => {
  it('a CLI that exits on its own reads idle on both topics, never ended', async () => {
    const dir = tempClaudeDir();
    const app = await buildServer({ ...dir, queryFn: fakeQueryFnSelfExiting() as any });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const id = randomUUID();
      const seen = await watch((app.server.address() as AddressInfo).port, id);
      await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: { cwd: dir.cwd, prompt: 'go', permissionMode: 'acceptEdits', sessionId: id },
      });
      await vi.waitFor(() => expect(seen.map.at(-1)).toBe('idle'), { timeout: 3000 });
      expect(seen.panel.at(-1)).toBe('idle');
      expect([...seen.map, ...seen.panel]).not.toContain('ended');
      expect((await sessionOf(app, id))?.status).toBe('idle');
      seen.ws.close();
    } finally {
      await app.close();
    }
  });

  it('End reads ended on both topics, without passing through idle', async () => {
    const dir = tempClaudeDir();
    const app = await buildServer({ ...dir, queryFn: fakeQueryFn() as any });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const id = randomUUID();
      const seen = await watch((app.server.address() as AddressInfo).port, id);
      await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: { cwd: dir.cwd, prompt: 'go', permissionMode: 'acceptEdits', sessionId: id },
      });
      await statusIs(app, id, 'needs_input');
      await app.inject({ method: 'POST', url: `/api/sessions/${id}/end` });
      await vi.waitFor(() => expect(seen.panel.at(-1)).toBe('ended'), { timeout: 3000 });
      expect(seen.map.at(-1)).toBe('ended');
      expect([...seen.map, ...seen.panel]).not.toContain('idle');

      // And Undo takes it back to idle, which the Runner's record of the
      // stop must not mask.
      await app.inject({ method: 'POST', url: `/api/sessions/${id}/reopen` });
      await vi.waitFor(() => expect(seen.map.at(-1)).toBe('idle'), { timeout: 3000 });
      seen.ws.close();
    } finally {
      await app.close();
    }
  });
});
