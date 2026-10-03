import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { Hub } from '../src/api/hub.js';
import { Runner } from '../src/runner/runner.js';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { limitWaits, sessions, settings as settingsTable } from '../src/db/schema.js';
import {
  AUTO_CONTINUE_KEY,
  CONTINUE_TEXT_KEY,
  DEFAULT_CONTINUE_TEXT,
  RESET_GRACE_MS,
  readRateLimitInfo,
  readUsageAnswer,
  waitFromLimitHit,
  whatFiringSends,
} from '../src/limits/logic.js';
import { LIMITS_TOPIC, LimitsService } from '../src/limits/service.js';
import { makeTmpDir, openTmpDb } from './tmp.js';
import { eq } from 'drizzle-orm';

// ---- Pure: the probe's answer --------------------------------------------

describe('readUsageAnswer', () => {
  it('reads limits[] in the server order, naming known kinds and passing unknown ones through', () => {
    const reading = readUsageAnswer({
      rate_limits_available: true,
      rate_limits: {
        limits: [
          { kind: 'weekly_scoped', percent: 12, resets_at: '2026-10-08T07:00:00Z', severity: 'normal', scope: { model: { display_name: 'Opus' } } },
          { kind: 'session', percent: 100, resets_at: '2026-10-03T13:00:00Z', severity: 'critical', scope: null },
          { kind: 'weekly_all', percent: 80, resets_at: null, severity: 'warning' },
          { kind: 'monthly_burst', percent: 5, resets_at: 'garbage', severity: 'mauve', scope: { model: { display_name: 'Fable' } } },
        ],
        five_hour: { utilization: 1, resets_at: null },
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: 24.68, currency: 'USD' },
      },
    });
    expect(reading.tracked).toBe(true);
    expect(reading.windows).toEqual([
      { kind: 'weekly_scoped', label: 'Weekly · Opus', percent: 12, resetsAt: '2026-10-08T07:00:00.000Z', severity: 'normal' },
      { kind: 'session', label: '5-hour window', percent: 100, resetsAt: '2026-10-03T13:00:00.000Z', severity: 'critical' },
      { kind: 'weekly_all', label: 'Weekly', percent: 80, resetsAt: null, severity: 'warning' },
      { kind: 'monthly_burst', label: 'monthly_burst · Fable', percent: 5, resetsAt: null, severity: 'normal' },
    ]);
    expect(reading.extraUsage).toEqual({ enabled: true, usedCredits: 1234, monthlyLimit: 5000, percent: 24.68, currency: 'USD' });
  });

  it('falls back to the fixed windows when limits[] is absent, grading severity from the percent', () => {
    const reading = readUsageAnswer({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 95, resets_at: '2026-10-03T13:00:00Z' },
        seven_day: { utilization: 76, resets_at: '2026-10-08T07:00:00Z' },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 3, resets_at: null },
      },
    });
    expect(reading.windows.map((w) => [w.kind, w.label, w.severity])).toEqual([
      ['five_hour', '5-hour window', 'critical'],
      ['seven_day', 'Weekly', 'warning'],
      ['seven_day_sonnet', 'Weekly · Sonnet', 'normal'],
    ]);
    expect(reading.extraUsage).toBeNull();
  });

  it('reads rate_limits_available: false as not tracked', () => {
    expect(readUsageAnswer({ rate_limits_available: false, rate_limits: null })).toEqual({ tracked: false, windows: [], extraUsage: null });
  });
});

// ---- Pure: the trigger and the firing ------------------------------------

describe('a limit hit becomes a wait', () => {
  it('reads resetsAt as epoch seconds, and an allowed status as no rejection', () => {
    expect(readRateLimitInfo({ status: 'rejected', resetsAt: 1_791_000_000, rateLimitType: 'seven_day' }))
      .toEqual({ resetsAt: 1_791_000_000_000, rateLimitType: 'seven_day' });
    expect(readRateLimitInfo({ status: 'rejected', resetsAt: 1_791_000_000_000 }))
      .toEqual({ resetsAt: 1_791_000_000_000, rateLimitType: null });
    expect(readRateLimitInfo({ status: 'allowed_warning', resetsAt: 1 })).toBe('allowed');
    expect(readRateLimitInfo(null)).toBeNull();
  });

  it('needs both the rejected event and the turn ending on the limit error', () => {
    const rejected = { resetsAt: 5_000, rateLimitType: 'five_hour' };
    const noProbe = () => null;
    expect(waitFromLimitHit(rejected, 'rate_limit', noProbe))
      .toEqual({ resetsAt: 5_000, windowKind: 'five_hour', windowLabel: '5-hour window' });
    expect(waitFromLimitHit(rejected, null, noProbe)).toBeNull();
    expect(waitFromLimitHit(rejected, 'overloaded', noProbe)).toBeNull();
    expect(waitFromLimitHit(null, 'rate_limit', noProbe)).toBeNull();
  });

  it('asks the probe when the event has no reset, and makes nothing when the probe has none either', () => {
    const rejected = { resetsAt: null, rateLimitType: 'seven_day_opus' };
    expect(waitFromLimitHit(rejected, 'rate_limit', (type) => (type === 'seven_day_opus' ? 9_000 : null)))
      .toEqual({ resetsAt: 9_000, windowKind: 'seven_day_opus', windowLabel: 'Weekly · Opus' });
    expect(waitFromLimitHit(rejected, 'rate_limit', () => null)).toBeNull();
  });
});

describe('whatFiringSends', () => {
  const on = { autoContinue: true, continueText: 'go on' };
  const off = { autoContinue: false, continueText: 'go on' };
  const queued = [{ text: 'first' }, { text: 'second', attachments: ['img1'] }];

  it('sends the queued messages as one turn, whatever the setting or Cancel says', () => {
    for (const s of [on, off]) {
      for (const cancelled of [false, true]) {
        expect(whatFiringSends({ cancelled, queued }, s)).toEqual({ text: 'first\n\nsecond', attachments: ['img1'] });
      }
    }
  });

  it('sends the continuation text only while the setting is on and the wait is not cancelled', () => {
    expect(whatFiringSends({ cancelled: false, queued: [] }, on)).toEqual({ text: 'go on', attachments: [] });
    expect(whatFiringSends({ cancelled: true, queued: [] }, on)).toBeNull();
    expect(whatFiringSends({ cancelled: false, queued: [] }, off)).toBeNull();
  });
});

// ---- The service: lifecycle and persistence ------------------------------

function service(db = openTmpDb('limits'), opts: { tracked?: boolean; answer?: unknown; now?: () => number } = {}) {
  const published: any[] = [];
  const republished: string[] = [];
  const delivered: { id: string; text: string; attachments: string[] }[] = [];
  const settings = {
    get: (key: string) =>
      db.select({ value: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, key)).get()?.value ?? '',
  };
  const probes: number[] = [];
  const queryFn = (() => {
    probes.push(1);
    async function* gen(): AsyncGenerator<any> {}
    const g = gen() as any;
    g.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => {
      if (opts.answer instanceof Error) throw opts.answer;
      return opts.answer ?? { rate_limits_available: true, rate_limits: { limits: [] } };
    };
    return g;
  }) as any;
  const limits = new LimitsService({
    db, hub: { publish: (topic, payload) => published.push({ topic, ...payload }) },
    settings, queryFn, tracked: opts.tracked ?? true,
    republish: (id) => republished.push(id),
    now: opts.now,
  });
  limits.deliver = async (id, text, attachments) => {
    delivered.push({ id, text, attachments });
    return { outcome: 'sent', uuid: 'u-1' };
  };
  return { db, limits, published, republished, delivered, probes };
}

function addSession(db: ReturnType<typeof openTmpDb>, id: string, extra: Partial<typeof sessions.$inferInsert> = {}) {
  db.insert(sessions).values({ id, projectDir: 'p', cwd: '/w', title: `title ${id}`, source: 'web', ...extra }).run();
}

const REJECTED = { resetsAt: 10_000, rateLimitType: 'five_hour' };

describe('LimitsService — waits', () => {
  it('makes a wait on a limit hit, shapes it, and keeps it across a restart', async () => {
    const { db, limits, republished } = service();
    addSession(db, 's1');
    expect(await limits.limitHit('s1', REJECTED, 'rate_limit')).toBe(true);
    expect(republished).toContain('s1');
    limits.queue('s1', 'also this', ['ref-a']);
    limits.setCancelled('s1', true);

    const restarted = service(db).limits;
    restarted.load();
    expect(restarted.waitFor('s1')).toEqual({
      resetsAt: new Date(10_000).toISOString(),
      windowKind: 'five_hour',
      windowLabel: '5-hour window',
      cancelled: true,
      willContinue: false,
      queued: ['also this'],
    });
    restarted.setCancelled('s1', false);
    expect(restarted.waitFor('s1')?.willContinue).toBe(true);
    expect(restarted.snapshot().waits).toEqual([
      { sessionId: 's1', title: 'title s1', resetsAt: new Date(10_000).toISOString(), windowLabel: '5-hour window', willContinue: true },
    ]);
  });

  it('makes no wait with an API key, or when the turn did not end on the limit', async () => {
    const keyed = service(undefined, { tracked: false });
    expect(await keyed.limits.limitHit('s1', REJECTED, 'rate_limit')).toBe(false);
    expect(keyed.limits.snapshot().tracked).toBe(false);
    const plan = service();
    expect(await plan.limits.limitHit('s1', REJECTED, null)).toBe(false);
    expect(plan.limits.isWaiting('s1')).toBe(false);
  });

  it('a new hit on a waiting session keeps what the user queued and clears Cancel', async () => {
    const { db, limits } = service();
    addSession(db, 's1');
    await limits.limitHit('s1', REJECTED, 'rate_limit');
    limits.queue('s1', 'keep me');
    limits.setCancelled('s1', true);
    await limits.limitHit('s1', { resetsAt: 20_000, rateLimitType: 'seven_day' }, 'rate_limit');
    expect(limits.waitFor('s1')).toMatchObject({ windowLabel: 'Weekly', cancelled: false, queued: ['keep me'] });
  });

  it('drops a wait when the session ends, and refuses to queue without one', async () => {
    const { db, limits } = service();
    addSession(db, 's1');
    await limits.limitHit('s1', REJECTED, 'rate_limit');
    limits.drop('s1');
    expect(limits.waitFor('s1')).toBeNull();
    expect(db.select().from(limitWaits).all()).toEqual([]);
    expect(limits.queue('s1', 'x')).toBe(false);
    expect(limits.setCancelled('s1', true)).toBe(false);
  });

  it('fires a due wait: queued messages first, the divider, and the wait gone', async () => {
    let now = 0;
    const { db, limits, delivered, published } = service(undefined, { now: () => now });
    addSession(db, 's1');
    await limits.limitHit('s1', REJECTED, 'rate_limit');
    limits.queue('s1', 'written while waiting');

    now = REJECTED.resetsAt + RESET_GRACE_MS - 1;
    await limits.fireDue();
    expect(delivered).toEqual([]);

    now = REJECTED.resetsAt + RESET_GRACE_MS;
    await limits.fireDue();
    expect(delivered).toEqual([{ id: 's1', text: 'written while waiting', attachments: [] }]);
    expect(limits.isWaiting('s1')).toBe(false);
    const notice = published.find((p) => p.topic === 'session:s1' && p.message?.role === 'notice');
    expect(notice.message.notice).toEqual({
      level: 'info', kind: 'limit_reset',
      limitReset: { resetsAt: new Date(10_000).toISOString(), windowLabel: '5-hour window', continued: true, sent: 'written while waiting' },
    });
    expect(published.some((p) => p.topic === 'session:s1' && p.message?.role === 'user' && p.message.uuid === 'u-1')).toBe(true);
    expect(published.at(-1)).toMatchObject({ topic: LIMITS_TOPIC, event: 'limits', limits: { waits: [] } });
  });

  it('sends the continuation text per the setting read at firing time', async () => {
    let now = 0;
    const { db, limits, delivered } = service(undefined, { now: () => now });
    addSession(db, 's1');
    addSession(db, 's2');
    await limits.limitHit('s1', REJECTED, 'rate_limit');
    await limits.limitHit('s2', REJECTED, 'rate_limit');
    limits.setCancelled('s2', true);
    db.update(settingsTable).set({ value: '' }).where(eq(settingsTable.key, CONTINUE_TEXT_KEY)).run();
    now = 1e9;
    await limits.fireDue();
    expect(delivered).toEqual([{ id: 's1', text: DEFAULT_CONTINUE_TEXT, attachments: [] }]);

    await limits.limitHit('s1', REJECTED, 'rate_limit');
    db.update(settingsTable).set({ value: 'false' }).where(eq(settingsTable.key, AUTO_CONTINUE_KEY)).run();
    await limits.fireDue();
    expect(delivered).toHaveLength(1);
    expect(limits.isWaiting('s1')).toBe(false);
  });

  it('fires an overdue wait on start, and never one for an ended session', async () => {
    const db = openTmpDb('limits-boot');
    addSession(db, 'live');
    addSession(db, 'gone', { endedAt: 5 });
    for (const sessionId of ['live', 'gone']) {
      db.insert(limitWaits).values({ sessionId, resetsAt: 1, windowKind: 'five_hour', windowLabel: '5-hour window', createdAt: 0 }).run();
    }
    const { limits, delivered } = service(db);
    limits.load();
    limits.start();
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0].id).toBe('live');
    await vi.waitFor(() => expect(db.select().from(limitWaits).all()).toEqual([]));
    limits.dispose();
  });
});

describe('LimitsService — the probe', () => {
  it('keeps the last good answer and marks it stale when a read fails', async () => {
    const answer: { value: unknown } = {
      value: { rate_limits_available: true, rate_limits: { limits: [{ kind: 'session', percent: 40, resets_at: null, severity: 'normal' }] } },
    };
    const db = openTmpDb('limits-probe');
    // The answer is swapped between reads.
    const limits = new LimitsService({
      db, hub: { publish: () => {} }, settings: { get: () => '' }, tracked: true, republish: () => {},
      queryFn: (() => {
        async function* gen(): AsyncGenerator<any> {}
        const g = gen() as any;
        g.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => {
          if (answer.value instanceof Error) throw answer.value;
          return answer.value;
        };
        return g;
      }) as any,
    });
    expect(limits.snapshot()).toMatchObject({ tracked: true, readAt: null, stale: false, windows: [] });
    await limits.refresh();
    const good = limits.snapshot();
    expect(good.readAt).not.toBeNull();
    expect(good.windows).toHaveLength(1);
    answer.value = new Error('offline');
    await limits.refresh();
    expect(limits.snapshot()).toMatchObject({ stale: true, readAt: good.readAt, windows: good.windows });
  });

  it('asks the probe for the reset when the event carries none', async () => {
    const { db, limits } = service(undefined, {
      answer: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: '2026-10-03T15:00:00Z' } } },
    });
    addSession(db, 's1');
    expect(await limits.limitHit('s1', { resetsAt: null, rateLimitType: 'five_hour' }, 'rate_limit')).toBe(true);
    expect(limits.waitFor('s1')?.resetsAt).toBe('2026-10-03T15:00:00.000Z');
  });
});

// ---- The runner's half ---------------------------------------------------

/** A fake SDK whose output stream the test writes message by message. */
function scripted() {
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  let sid = 'unpinned';
  const fn = ({ options }: { options: any }) => {
    sid = options?.sessionId ?? options?.resume ?? 'unpinned';
    async function* gen() {
      for (;;) {
        while (queue.length) yield { session_id: sid, ...queue.shift() };
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    }
    return gen() as any;
  };
  return {
    fn,
    push(msg: Record<string, unknown>) {
      queue.push(msg);
      const w = wake;
      wake = null;
      w?.();
    },
  };
}

describe('Runner — usage limits', () => {
  function limitRunner() {
    const script = scripted();
    const waiting = new Set<string>();
    const hits: any[] = [];
    let events = 0;
    const runner = new Runner({
      hub: new Hub(), queryFn: script.fn as any, newSessionId: () => 'web-1',
      onRateLimit: () => { events++; },
      onLimitHit: (sessionId, rejected, turnError) => {
        hits.push({ sessionId, rejected, turnError });
        if (turnError === 'rate_limit') waiting.add(sessionId);
      },
      isLimitWaiting: (sessionId) => waiting.has(sessionId),
    });
    return { runner, script, hits, events: () => events };
  }

  it('a rejected event and a turn ending on the limit error settle the session idle', async () => {
    const { runner, script, hits, events } = limitRunner();
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' });
    script.push({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_791_000_000, rateLimitType: 'five_hour' } });
    script.push({
      type: 'assistant', error: 'rate_limit', parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your limit" }] },
    });
    script.push({ type: 'result', subtype: 'success', is_error: true, usage: {} });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('idle'));
    expect(hits).toEqual([{
      sessionId: 'web-1',
      rejected: { resetsAt: 1_791_000_000_000, rateLimitType: 'five_hour' },
      turnError: 'rate_limit',
    }]);
    expect(events()).toBe(1);
    await runner.stop('web-1');
  });

  it('an allowed event asks nothing, and a rejection does not outlive its turn', async () => {
    const { runner, script, hits } = limitRunner();
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' });
    script.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1_791_000_000 } });
    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    expect(hits).toHaveLength(0);
    // A subagent's request rejected, the main turn ending fine: asked, and no error.
    script.push({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_791_000_000 } });
    script.push({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(hits).toHaveLength(1));
    expect(hits[0].turnError).toBeNull();
    // The next turn carries no rejection over.
    script.push({ type: 'assistant', error: 'rate_limit', parent_tool_use_id: null, message: { role: 'assistant', content: [] } });
    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    expect(hits).toHaveLength(1);
    await runner.stop('web-1');
  });
});

// ---- The routes ----------------------------------------------------------

describe('limits routes', () => {
  async function app(answer: unknown = { rate_limits_available: true, rate_limits: { limits: [{ kind: 'session', percent: 40, resets_at: null, severity: 'normal' }] } }) {
    const dir = makeTmpDir('limits-routes');
    const dbPath = join(dir, 'index.db');
    const seed = openDb(dbPath);
    seed.insert(sessions).values({ id: 'w1', projectDir: 'p', cwd: dir, title: 'waiting one', source: 'web' }).run();
    seed.insert(sessions).values({ id: 'n1', projectDir: 'p', cwd: dir, title: 'not waiting', source: 'web' }).run();
    seed.insert(limitWaits).values({
      sessionId: 'w1', resetsAt: Date.now() + 3_600_000, windowKind: 'five_hour', windowLabel: '5-hour window', createdAt: 0,
    }).run();
    seed.$client.close();
    const queryFn = (() => {
      async function* gen(): AsyncGenerator<any> {}
      const g = gen() as any;
      g.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => answer;
      return g;
    }) as any;
    return buildServer({ dbPath, claudeDir: dir, dataDir: dir, queryFn });
  }

  it('serves the snapshot, reads again on POST, and carries the wait on the session', async () => {
    const server = await app();
    const first = (await server.inject({ method: 'GET', url: '/api/limits' })).json();
    expect(first.tracked).toBe(true);
    expect(first.waits).toEqual([expect.objectContaining({ sessionId: 'w1', title: 'waiting one', windowLabel: '5-hour window', willContinue: true })]);
    const fresh = (await server.inject({ method: 'POST', url: '/api/limits/refresh' })).json();
    expect(fresh.readAt).not.toBeNull();
    expect(fresh.windows).toEqual([{ kind: 'session', label: '5-hour window', percent: 40, resetsAt: null, severity: 'normal' }]);

    const session = (await server.inject({ method: 'GET', url: '/api/sessions/w1' })).json();
    expect(session.session.limitWait).toMatchObject({ windowKind: 'five_hour', cancelled: false, queued: [] });
    await server.close();
  });

  it('cancels and undoes a wait, 404 without one', async () => {
    const server = await app();
    expect((await server.inject({ method: 'POST', url: '/api/sessions/w1/limit-wait/cancel' })).statusCode).toBe(204);
    expect((await server.inject({ method: 'GET', url: '/api/limits' })).json().waits[0].willContinue).toBe(false);
    expect((await server.inject({ method: 'POST', url: '/api/sessions/w1/limit-wait/undo' })).statusCode).toBe(204);
    expect((await server.inject({ method: 'POST', url: '/api/sessions/n1/limit-wait/cancel' })).statusCode).toBe(404);
    await server.close();
  });

  it('holds a message sent to a waiting session instead of sending it', async () => {
    const server = await app();
    const res = await server.inject({ method: 'POST', url: '/api/sessions/w1/messages', payload: { text: 'later please' } });
    expect(res.json()).toEqual({ ok: true, queued: true });
    const snap = (await server.inject({ method: 'GET', url: '/api/sessions/w1' })).json();
    expect(snap.session.limitWait.queued).toEqual(['later please']);
    await server.close();
  });

  it('ending the session drops its wait', async () => {
    const server = await app();
    await server.inject({ method: 'POST', url: '/api/sessions/w1/end' });
    expect((await server.inject({ method: 'GET', url: '/api/limits' })).json().waits).toEqual([]);
    await server.close();
  });
});
