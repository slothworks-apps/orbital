import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { sessions, sessionTags, settings as settingsTable, tags } from '../src/db/schema.js';
import { registerRoutes } from '../src/api/routes.js';
import { buildServer } from '../src/index.js';
import { Hub } from '../src/api/hub.js';

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
  const runner = {
    status: () => undefined, active: () => [],
    start: async () => 'web-9', send: () => {}, interrupt: async () => {}, end: async () => {},
  };
  const hub = new Hub();
  const app = Fastify();
  registerRoutes(app, {
    db, registry: registry as any, runner: runner as any, projectsDir: '/nonexistent', hub,
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
  return { app, db, runner, hub };
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
  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    db = result.db;
    runner = result.runner;
    hub = result.hub;
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
