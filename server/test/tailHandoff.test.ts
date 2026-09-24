import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { sessions } from '../src/db/schema.js';

/**
 * A subscribed session topic has two possible feeds — the Runner's SDK
 * stream while the Runner owns the session, and a transcript tail while it
 * does not — and exactly one of them may run at a time
 * (adr: the-tail-yields-to-the-runner).
 *
 * Reproduced against the desktop app's own server on 2026-09-23: a session
 * opened in the panel after it had ended got a tail; sending into it revived
 * it, and the reply then arrived twice, once from each feed.
 */

/** Fake SDK that answers every prompt with one assistant line and a result. */
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

const assistantLine = (uuid: string) =>
  `{"type":"assistant","uuid":"${uuid}","message":{"role":"assistant","content":[{"type":"text","text":"from the file"}]}}\n`;

async function sessionOf(app: any, id: string) {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  return res.json().sessions.find((s: { id: string }) => s.id === id);
}

const statusIs = (app: any, id: string, status: string) =>
  vi.waitFor(async () => expect((await sessionOf(app, id))?.status).toBe(status), { timeout: 3000 });

/** One real socket on the topic, collecting every `message` frame's id. */
function subscribe(port: number, topic: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const ids: string[] = [];
  const events: string[] = [];
  ws.onmessage = (e) => {
    const frame = JSON.parse(String(e.data));
    if (frame.topic !== topic) return;
    events.push(frame.event);
    if (frame.event === 'message') ids.push(frame.message.id);
  };
  const open = new Promise<void>((resolve) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe', topic }));
      resolve();
    };
  });
  return { ws, ids, events, open };
}

/**
 * Appends one fresh probe line every 300ms until `check` passes (or, for a
 * negative assertion, holds for the whole `timeout`). Fresh lines rather
 * than one append plus mtime nudges, because two races sit between an
 * append and the socket and both are answered by a later append: the
 * subscribe frame has no ack, so a tail can start at an EOF that is already
 * past the first probe; and `fs.watch` can miss a write that lands right as
 * the watch is registered (the race `tail.test.ts` documents). The probe
 * ids carry `prefix`, so the assertions can name which phase's writes they
 * are about. Used for both polarities — an assertion that the tail did NOT
 * fire needs live writes to fail on, or it would pass for the wrong reason.
 */
async function probing(
  file: string,
  prefix: string,
  check: () => void,
  budget: { until: number } | { holds: number },
) {
  const timeout = 'until' in budget ? budget.until : budget.holds;
  const deadline = Date.now() + timeout;
  for (let n = 1; ; n += 1) {
    appendFileSync(file, assistantLine(`${prefix}-${n}`));
    await new Promise((r) => setTimeout(r, 300));
    if ('until' in budget) {
      // Waiting for it to become true: done on the first pass.
      try {
        check();
        return;
      } catch (err) {
        if (Date.now() >= deadline) throw err;
      }
    } else {
      // Must stay true under live writes for the whole budget.
      check();
      if (Date.now() >= deadline) return;
    }
  }
}

const anyWithPrefix = (ids: string[], prefix: string) => ids.filter((id) => id.startsWith(`${prefix}-`));

describe('the transcript tail yields to the Runner', () => {
  it('runs only while nobody owns the session: stopped by a revive, restarted by the end', async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-tail-handoff-'));
    mkdirSync(join(claudeDir, 'projects', 'p'), { recursive: true });
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
    const dbPath = join(claudeDir, 'index.db');
    const app = await buildServer({ claudeDir, dbPath, queryFn: fakeQueryFn() as any });
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: { cwd: claudeDir, prompt: 'go', permissionMode: 'acceptEdits' },
      });
      const { sessionId } = created.json();
      await statusIs(app, sessionId, 'needs_input');
      await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/end` });
      await statusIs(app, sessionId, 'ended');

      // The transcript the CLI would have written, where the indexer would
      // have placed it. Non-empty, so the tail's EOF start has something to
      // be past.
      const db = openDb(dbPath);
      db.update(sessions).set({ projectDir: 'p' }).where(eq(sessions.id, sessionId)).run();
      db.$client.close();
      const file = join(claudeDir, 'projects', 'p', `${sessionId}.jsonl`);
      writeFileSync(file, assistantLine('a-history'));

      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      const topic = `session:${sessionId}`;
      const sub = subscribe(port, topic);
      await sub.open;
      // A subscription on an ended session is what starts the tail: an
      // append now reaches the socket, which is also the proof that the
      // subscribe frame has landed before anything below relies on it.
      await probing(file, 'before', () => expect(anyWithPrefix(sub.ids, 'before')).not.toHaveLength(0), { until: 10_000 });

      // Reviving hands the session to the Runner; its reply comes off the
      // SDK stream once, and the CLI's write of the same reply into the
      // transcript must no longer be re-published by the tail.
      const revived = await app.inject({
        method: 'POST', url: `/api/sessions/${sessionId}/messages`,
        payload: { text: 'again' },
      });
      expect(revived.json()).toEqual({ ok: true, revived: true });
      await vi.waitFor(() => expect(sub.events).toContain('turn_result'), { timeout: 3000 });
      await probing(file, 'during', () => {
        expect(sub.ids.filter((id) => id.startsWith(`${sessionId}:`))).toHaveLength(1);
        expect(anyWithPrefix(sub.ids, 'during')).toHaveLength(0);
      }, { holds: 1500 });

      // Ending releases the session while the topic is still watched, so
      // the tail comes back for whatever appends next — a terminal resuming
      // the session, say.
      await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/end` });
      await statusIs(app, sessionId, 'ended');
      await probing(file, 'after', () => expect(anyWithPrefix(sub.ids, 'after')).not.toHaveLength(0), { until: 10_000 });
      // And still nothing from the writes made while the Runner had it: the
      // restarted tail begins at the new EOF, it does not replay them.
      expect(anyWithPrefix(sub.ids, 'during')).toHaveLength(0);

      sub.ws.close();
    } finally {
      await app.close();
    }
    // Two watched appends, each given the tail test's own 10s budget.
  }, 40_000);
});
