import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { sessions, settings } from '../src/db/schema.js';

/**
 * Autoheal across the whole chain: a server that dies still owning a session
 * leaves `runner_status` standing, and the next boot resumes it instead of
 * letting it read `ended` (spec 2026-09-21-session-autoheal-design).
 *
 * `app.close()` is the kill. It disposes the Runner's timers and never calls
 * `finish()`, which is exactly what `tsx watch` does to a running server —
 * the flag survives because nothing was given the chance to clear it.
 */

/** Fake SDK that completes each turn, the way a healthy session behaves. */
function fakeQueryFn() {
  return ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
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
function fakeQueryFnStalling() {
  return ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
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

function tempClaudeDir() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-autoheal-e2e-'));
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  return { claudeDir, dbPath: join(claudeDir, 'index.db'), cwd: claudeDir };
}

async function sessionOf(app: any, id: string) {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  return res.json().sessions.find((s: { id: string }) => s.id === id);
}

/** Starts a session on one server, then kills that server mid-life. */
async function killWhileRunning(
  dir: { claudeDir: string; dbPath: string; cwd: string },
  queryFn: ReturnType<typeof fakeQueryFn>,
  settle: (app: any, id: string) => Promise<void>,
) {
  const app = await buildServer({ ...dir, queryFn: queryFn as any });
  const created = await app.inject({
    method: 'POST', url: '/api/sessions',
    payload: { cwd: dir.cwd, prompt: 'go', permissionMode: 'acceptEdits' },
  });
  const { sessionId } = created.json();
  await settle(app, sessionId);
  await app.close();
  return sessionId;
}

const settled = async (app: any, id: string) =>
  vi.waitFor(async () => expect((await sessionOf(app, id))?.status).toBe('needs_input'), { timeout: 3000 });

const working = async (app: any, id: string) =>
  vi.waitFor(async () => expect((await sessionOf(app, id))?.status).toBe('working'), { timeout: 3000 });

describe('session autoheal, end to end', () => {
  it('brings back a session the previous server was still running', async () => {
    const dir = tempClaudeDir();
    const id = await killWhileRunning(dir, fakeQueryFn(), settled);

    const app = await buildServer({ ...dir, queryFn: fakeQueryFn() as any });
    try {
      await vi.waitFor(async () => {
        expect((await sessionOf(app, id))?.status).toBe('needs_input');
      }, { timeout: 3000 });
      // Healed, not merely displayed as alive: the session takes a message
      // without the send path having to revive it.
      expect((await sessionOf(app, id))?.interruptedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('marks a session that was cut off mid-turn', async () => {
    const dir = tempClaudeDir();
    const id = await killWhileRunning(dir, fakeQueryFnStalling(), working);

    const app = await buildServer({ ...dir, queryFn: fakeQueryFn() as any });
    try {
      await vi.waitFor(async () => {
        const s = await sessionOf(app, id);
        expect(s?.status).toBe('needs_input');
        expect(s?.interruptedAt).toEqual(expect.any(Number));
      }, { timeout: 3000 });
    } finally {
      await app.close();
    }
  });

  it('clears the mark once the session runs a turn again', async () => {
    const dir = tempClaudeDir();
    const id = await killWhileRunning(dir, fakeQueryFnStalling(), working);

    const app = await buildServer({ ...dir, queryFn: fakeQueryFn() as any });
    try {
      await vi.waitFor(async () => {
        expect((await sessionOf(app, id))?.interruptedAt).toEqual(expect.any(Number));
      }, { timeout: 3000 });
      await app.inject({
        method: 'POST', url: `/api/sessions/${id}/messages`, payload: { text: 'carry on' },
      });
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
    await settled(app1, id);
    await app1.inject({ method: 'POST', url: `/api/sessions/${id}/clear`, payload: {} });
    await app1.close();

    const app = await buildServer({ ...dir, queryFn: fakeQueryFn() as any });
    try {
      expect((await sessionOf(app, id))?.status).toBe('ended');
    } finally {
      await app.close();
    }
  });

  it('leaves a session the idle timer would already have ended', async () => {
    const dir = tempClaudeDir();
    const id = await killWhileRunning(dir, fakeQueryFn(), settled);

    // Backdate it past the idle window the user chose, which is the window
    // autoheal borrows.
    const db = openDb(dir.dbPath);
    db.insert(settings).values({ key: 'ended_after_idle_minutes', value: '30' })
      .onConflictDoUpdate({ target: settings.key, set: { value: '30' } }).run();
    db.update(sessions).set({ lastAt: Date.now() - 31 * 60_000 }).where(eq(sessions.id, id)).run();
    db.$client.close();

    const app = await buildServer({ ...dir, queryFn: fakeQueryFn() as any });
    try {
      expect((await sessionOf(app, id))?.status).toBe('ended');
      // And the flag is cleared, so it cannot resurrect at some later boot.
      const after = openDb(dir.dbPath);
      const row = after.select({ runnerStatus: sessions.runnerStatus })
        .from(sessions).where(eq(sessions.id, id)).get();
      expect(row?.runnerStatus).toBeNull();
      after.$client.close();
    } finally {
      await app.close();
    }
  });
});
