import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { sessions, sessionTags, settings as settingsTable, tags } from '../src/db/schema.js';
import { registerRoutes } from '../src/api/routes.js';
import { buildServer, publishLiveSession } from '../src/index.js';
import { Hub } from '../src/api/hub.js';
import { Runner } from '../src/runner/runner.js';
import { resolveClaudeCodeVersion } from '../src/runner/version.js';

function makeApp() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'orbital-api-')), 'index.db'));
  db.insert(tags).values({ id: 10, name: 'work', hue: 210 }).run();
  db.insert(sessions)
    .values([
      {
        id: 's1', projectDir: 'p', cwd: '/w/x', title: 'auth fix', lastAt: 200,
        source: 'terminal', permissionMode: 'acceptEdits',
      },
      {
        id: 's2', projectDir: 'p', cwd: '/w/y', title: 'recipe', lastAt: 100,
        source: 'terminal', permissionMode: null,
      },
    ])
    .run();
  db.insert(sessionTags).values({ sessionId: 's1', tagId: 10, origin: 'manual' }).run();
  const registry = {
    get: (id: string) => (id === 's1' ? { sessionId: 's1', status: 'working' } : undefined),
    all: () => [{ sessionId: 's1', status: 'working' }],
  };
  const startCalls: any[] = [];
  const runner = {
    status: () => undefined, active: () => [],
    start: async (body: any) => { startCalls.push(body); return 'web-9'; },
    send: (id: string) => { throw new Error(`session ${id} is not active`); },
    interrupt: async () => {}, end: async () => {},
  };
  const hub = new Hub();
  const modelCatalog = {
    list: async () => [
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', shortVersion: 'Sonnet 5', variant: null, blurb: 'Efficient', contextWindow: 200_000 },
    ],
    recordContextWindows: () => {},
  };
  const app = Fastify();
  registerRoutes(app, {
    db, registry: registry as any, runner: runner as any, projectsDir: '/nonexistent', hub,
    models: modelCatalog as any,
    settings: {
      get: (k: string) =>
        db.select({ value: settingsTable.value }).from(settingsTable)
          .where(eq(settingsTable.key, k)).get()?.value ?? '',
      set: (k: string, v: string) =>
        void db
          .insert(settingsTable)
          .values({ key: k, value: v })
          .onConflictDoUpdate({ target: settingsTable.key, set: { value: v } })
          .run(),
    },
  });
  return { app, db, runner, hub, registry, startCalls, modelCatalog };
}

/** Subscribes a fake socket to a Hub topic and collects published payloads. */
function subscribeFake(hub: Hub, topic: string) {
  const received: any[] = [];
  const socket: any = {
    send: (d: string) => received.push(JSON.parse(d)),
    handlers: {} as Record<string, Function>,
    on(ev: string, cb: Function) { this.handlers[ev] = cb; },
  };
  hub.handleSocket(socket);
  socket.handlers['message'](JSON.stringify({ type: 'subscribe', topic }));
  return received;
}

describe('REST routes', () => {
  let app: FastifyInstance;
  let db: any;
  let runner: any;
  let hub: Hub;
  let registry: any;
  let startCalls: any[];
  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    db = result.db;
    runner = result.runner;
    hub = result.hub;
    registry = result.registry;
    startCalls = result.startCalls;
  });

  it('GET /api/sessions lists by recency with merged status and tags', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions.map((s: any) => s.id)).toEqual(['s1', 's2']);
    expect(body.sessions[0]).toMatchObject({ status: 'working', tagIds: [10] });
    expect(body.sessions[1].status).toBe('ended');
  });

  it('GET /api/sessions?tag=10&q=auth filters', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions?tag=10&q=auth' });
    expect(res.json().sessions.map((s: any) => s.id)).toEqual(['s1']);
  });

  it('PATCH /api/sessions/:id renames', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/sessions/s1', payload: { title: 'renamed' },
    });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/sessions?q=renamed' });
    expect(list.json().sessions).toHaveLength(1);
  });

  it('PUT /api/sessions/:id/tags records manual add and removal', async () => {
    await app.inject({ method: 'PUT', url: '/api/sessions/s2/tags', payload: { tagIds: [10] } });
    const list = await app.inject({ method: 'GET', url: '/api/sessions?tag=10' });
    expect(list.json().sessions.map((s: any) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('PUT /api/sessions/:id/tags removing a rule-derived tag actually removes it (C1)', async () => {
    // Create a tag whose rule matches s1's cwd, so session_tags gets a
    // 'rule'-origin row for it.
    const tagRes = await app.inject({
      method: 'POST', url: '/api/tags', payload: { name: 'ruletag', hue: 5 },
    });
    const ruleTagId = tagRes.json().id;
    const ruleRes = await app.inject({
      method: 'POST', url: '/api/tag-rules',
      payload: { tagId: ruleTagId, condition: 'path_matches', pattern: '/w/x' },
    });
    const ruleId = ruleRes.json().id;

    const before = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
    expect(before.json().session.tagIds).toContain(ruleTagId);

    // Remove every tag via PUT, including the rule-derived one.
    await app.inject({ method: 'PUT', url: '/api/sessions/s1/tags', payload: { tagIds: [] } });
    const after = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
    expect(after.json().session.tagIds).not.toContain(ruleTagId);

    // An unrelated rule mutation re-runs regenerateRuleTags; the manual
    // removal must still be honored (the tag must not come back).
    await app.inject({ method: 'PATCH', url: `/api/tag-rules/${ruleId}`, payload: { position: 0 } });
    const afterMutation = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
    expect(afterMutation.json().session.tagIds).not.toContain(ruleTagId);
  });

  it('tags + rules CRUD and preview', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/tags', payload: { name: 'oncall', hue: 60 },
    });
    expect(created.statusCode).toBe(201);
    const tagId = created.json().id;
    const rule = await app.inject({
      method: 'POST', url: '/api/tag-rules',
      payload: { tagId, condition: 'path_matches', pattern: '/oncall/**' },
    });
    expect(rule.statusCode).toBe(201);
    const preview = await app.inject({
      method: 'POST', url: '/api/tag-rules/preview',
      payload: { cwd: '/oncall/runbooks', title: '', permissionMode: null },
    });
    expect(preview.json()).toMatchObject({ tagId });
  });

  it('GET /api/tags and /api/tag-rules preserve original snake_case key order (derived projection maps)', async () => {
    const tagsRes = await app.inject({ method: 'GET', url: '/api/tags' });
    expect(Object.keys(tagsRes.json().tags[0])).toEqual(['id', 'name', 'hue', 'is_default']);

    await app.inject({
      method: 'POST', url: '/api/tag-rules',
      payload: { tagId: 10, condition: 'path_matches', pattern: '/w/x' },
    });
    const rulesRes = await app.inject({ method: 'GET', url: '/api/tag-rules' });
    expect(Object.keys(rulesRes.json().rules[0])).toEqual([
      'id', 'tag_id', 'position', 'enabled', 'condition', 'pattern',
    ]);
  });

  it('POST /api/sessions starts a web session via the runner', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: 'web-9' });
  });

  it('POST /api/sessions publishes an upsert on the sessions topic (I3)', async () => {
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' },
    });
    expect(res.statusCode).toBe(201);
    const upserts = received.filter((r) => r.event === 'upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].session).toMatchObject({ id: 'web-9', status: 'ended' });
  });

  it('POST /sessions/:id/messages revives an ended session via resume', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s2/messages', payload: { text: 'wake up' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, revived: true });
    expect(startCalls.at(-1)).toMatchObject({ resume: 's2', prompt: 'wake up', cwd: '/w/y' });
  });

  it('POST /sessions/:id/messages revive publishes an upsert with status "working" on the sessions topic (F1)', async () => {
    // The runner reports the revived session as 'working' once start() has
    // registered it — mirrors a real runner picking the resumed session up.
    runner.status = (id: string) => (id === 's2' ? 'working' : undefined);
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s2/messages', payload: { text: 'wake up' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, revived: true });
    const upserts = received.filter((r) => r.event === 'upsert' && r.session.id === 's2');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].session).toMatchObject({ id: 's2', status: 'working' });
  });

  it('POST /sessions/:id/messages 409s for a live terminal session', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s1/messages', payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(409); // s1 is live in the registry fake
  });

  it('POST /sessions/:id/messages 404s for an unknown session', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/does-not-exist/messages', payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('registry upsert publishes REST-shaped session on the sessions topic', () => {
    const received = subscribeFake(hub, 'sessions');
    const live = {
      sessionId: 's1', pid: 1, cwd: '/w/x', name: 'auth fix',
      status: 'working' as const, kind: 'claude', startedAt: 0, updatedAt: 500,
    };
    publishLiveSession({ hub, db, registry: registry as any, runner: runner as any }, live);
    const upserts = received.filter((r) => r.event === 'upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].session).toMatchObject({ id: 's1', status: 'working', tagIds: [10] });
  });

  it('registry upsert for a session with no DB row falls back to the live-only shape', () => {
    const received = subscribeFake(hub, 'sessions');
    const live = {
      sessionId: 'term-9', pid: 1, cwd: '/w/z', name: 'untracked',
      status: 'idle' as const, kind: 'claude', startedAt: 0, updatedAt: 700,
    };
    publishLiveSession({ hub, db, registry: registry as any, runner: runner as any }, live);
    const upserts = received.filter((r) => r.event === 'upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].session).toMatchObject({
      id: 'term-9', cwd: '/w/z', title: 'untracked', source: 'terminal',
      status: 'idle', tagIds: [], lastAt: 700,
    });
  });

  it('GET /api/models serves the catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json().models[0]).toMatchObject({ value: 'sonnet', family: 'Sonnet', contextWindow: 200_000 });
  });

  it('GET and PATCH /api/settings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.json().default_permission_mode).toBe('acceptEdits');
    await app.inject({
      method: 'PATCH', url: '/api/settings', payload: { lineage_depth: '5' },
    });
    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(after.json().lineage_depth).toBe('5');
  });

  it('POST /api/sessions/:id/clear with startNew uses computed permission mode', async () => {
    // Capture runner.start() calls
    const startCalls: any[] = [];
    runner.start = async (body: any) => {
      startCalls.push(body);
      return 'web-10';
    };

    // Set inherit_permission_mode to false, default to plan, and inherit_tags to false
    await app.inject({
      method: 'PATCH', url: '/api/settings',
      payload: {
        inherit_permission_mode: 'false',
        default_permission_mode: 'plan',
        inherit_tags: 'false',
      },
    });

    // Old session has acceptEdits mode, but we should use default (plan) because inherit is false
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s1/clear',
      payload: { startNew: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionId: 'web-10' });

    // Verify runner.start() received the default (plan) mode, not old session's mode
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].permissionMode).toBe('plan');

    // Verify new session in DB has the default mode
    const newSession = db
      .select({ permissionMode: sessions.permissionMode, parentId: sessions.parentId })
      .from(sessions)
      .where(eq(sessions.id, 'web-10'))
      .get()!;
    expect(newSession.permissionMode).toBe('plan');
    expect(newSession.parentId).toBe('s1');

    // Verify manual tags are NOT copied (inherit_tags=false)
    const newTags = db
      .select({ tagId: sessionTags.tagId })
      .from(sessionTags)
      .where(eq(sessionTags.sessionId, 'web-10'))
      .all();
    expect(newTags).toHaveLength(0);

    // Now test with inherit_tags=true
    await app.inject({
      method: 'PATCH', url: '/api/settings',
      payload: { inherit_tags: 'true' },
    });

    const res2 = await app.inject({
      method: 'POST', url: '/api/sessions/s1/clear',
      payload: { startNew: true },
    });
    expect(res2.statusCode).toBe(200);
    const newSessionId = res2.json().sessionId;

    // Verify manual tags ARE copied
    const copiedTags = db
      .select({ tagId: sessionTags.tagId })
      .from(sessionTags)
      .where(eq(sessionTags.sessionId, newSessionId))
      .all();
    expect(copiedTags).toHaveLength(1);
    expect(copiedTags[0].tagId).toBe(10);
  });

  it('POST /api/sessions/:id/clear with startNew publishes an upsert for the new session on the sessions topic', async () => {
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s1/clear',
      payload: { startNew: true },
    });
    expect(res.statusCode).toBe(200);
    const newId = res.json().sessionId;
    const upserts = received.filter((r) => r.event === 'upsert' && r.session.id === newId);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].session).toMatchObject({ id: newId, parentId: 's1', source: 'web' });
  });
});

describe('buildServer smoke', () => {
  it('boots, serves /api/sessions and /ws upgrade route exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-boot-'));
    const app = await buildServer({
      dbPath: join(dir, 'index.db'),
      claudeDir: dir, // empty: no projects/, no sessions/ — must still boot
    });
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessions: [] });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/settings → Runner (the idle timeout used to be boot-only)
// ---------------------------------------------------------------------------

describe('PATCH /api/settings propagates the idle timeout to the Runner', () => {
  function makeAppWithRealRunner() {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'orbital-idle-')), 'index.db'));
    const hub = new Hub();
    const runner = new Runner({ hub, queryFn: (() => {}) as any, idleTimeoutMs: 30 * 60_000 });
    const applied: Array<number | null> = [];
    const original = runner.setIdleTimeoutMs.bind(runner);
    runner.setIdleTimeoutMs = (ms: number | null) => {
      applied.push(ms);
      original(ms);
    };
    const app = Fastify();
    registerRoutes(app, {
      db,
      registry: { get: () => undefined, all: () => [] } as any,
      runner,
      projectsDir: '/nonexistent',
      hub,
      models: { list: async () => [], recordContextWindows: () => {} } as any,
      settings: {
        get: (k: string) =>
          db.select({ value: settingsTable.value }).from(settingsTable)
            .where(eq(settingsTable.key, k)).get()?.value ?? '',
        set: (k: string, v: string) =>
          void db
            .insert(settingsTable)
            .values({ key: k, value: v })
            .onConflictDoUpdate({ target: settingsTable.key, set: { value: v } })
            .run(),
      },
    });
    return { app, db, applied };
  }

  it('hands the Runner the new minute count without a restart', async () => {
    const { app, db, applied } = makeAppWithRealRunner();
    await app.inject({
      method: 'PATCH', url: '/api/settings', payload: { ended_after_idle_minutes: '15' },
    });
    expect(applied).toEqual([15 * 60_000]);
    // ...and the value is still persisted, unchanged on the wire.
    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(after.json().ended_after_idle_minutes).toBe('15');
    db.$client.close();
  });

  it('hands the Runner a null timeout for the "never" sentinel', async () => {
    const { app, db, applied } = makeAppWithRealRunner();
    await app.inject({
      method: 'PATCH', url: '/api/settings', payload: { ended_after_idle_minutes: 'never' },
    });
    // Not NaN, not 0 — `setTimeout(fn, NaN)` would end every session at once.
    expect(applied).toEqual([null]);
    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(after.json().ended_after_idle_minutes).toBe('never');
    db.$client.close();
  });

  it('leaves the Runner alone for unrelated settings keys', async () => {
    const { app, db, applied } = makeAppWithRealRunner();
    await app.inject({
      method: 'PATCH', url: '/api/settings', payload: { lineage_depth: '5' },
    });
    expect(applied).toEqual([]);
    db.$client.close();
  });
});

// ---------------------------------------------------------------------------
// claude_code_version (task 3)
// ---------------------------------------------------------------------------

describe('claude_code_version', () => {
  it('resolves the bundled Claude Code CLI version, or nothing at all', () => {
    const version = resolveClaudeCodeVersion();
    // Never a placeholder: either a real dotted version or null.
    if (version !== null) expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('buildServer publishes it through GET /api/settings when resolvable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-ver-'));
    const app = await buildServer({
      dbPath: join(dir, 'index.db'),
      claudeDir: join(dir, 'claude'),
      queryFn: (() => {}) as any,
    });
    const body = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    const expected = resolveClaudeCodeVersion();
    if (expected === null) {
      // Unresolvable: the key stays absent so the UI row stays hidden.
      expect('claude_code_version' in body).toBe(false);
    } else {
      expect(body.claude_code_version).toBe(expected);
    }
    // The rest of the settings payload is untouched.
    expect(body.ended_after_idle_minutes).toBe('30');
    await app.close();
  });
});
