import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { sessionColumns, sessions, sessionTags, settings as settingsTable, tags } from '../src/db/schema.js';
import { registerRoutes } from '../src/api/routes.js';
import { buildServer, publishLiveSession } from '../src/index.js';
import { Hub } from '../src/api/hub.js';
import { Runner } from '../src/runner/runner.js';
import { resolveClaudeCodeVersion } from '../src/runner/version.js';
import type { SessionRow } from '../src/types.js';
import { SubagentStore } from '../src/transcript/subagents.js';
import { ErrorLog } from '../src/errors/log.js';

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
  const subagents = new SubagentStore();
  const errors = new ErrorLog({ db, hub });
  registerRoutes(app, {
    db, registry: registry as any, runner: runner as any, projectsDir: '/nonexistent', hub,
    models: modelCatalog as any,
    subagents,
    errors,
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
  return { app, db, runner, hub, registry, startCalls, modelCatalog, subagents, errors };
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
  let subagents: SubagentStore;
  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    db = result.db;
    runner = result.runner;
    hub = result.hub;
    registry = result.registry;
    startCalls = result.startCalls;
    subagents = result.subagents;
  });

  it('GET /api/sessions carries each session\'s running subagents', async () => {
    subagents.feed('s1', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Task', input: { description: 'reviewer' } },
          ],
        },
      },
    ]);
    const body = (await app.inject({ method: 'GET', url: '/api/sessions' })).json();
    expect(body.sessions[0].subagents).toEqual([
      { id: 't1', name: 'reviewer', state: 'working' },
    ]);
    // A session with none says so explicitly rather than omitting the field.
    expect(body.sessions[1].subagents).toEqual([]);
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
    // s1 is seeded with a manual tag, and a manual pick outranks a rule tag
    // (one tag per session) — so drop it first, or the rule tag below would
    // never be the effective one.
    await app.inject({ method: 'PUT', url: '/api/sessions/s1/tags', payload: { tagIds: [] } });

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

  // A just-launched session has a row (`project_dir: ''`) and no transcript
  // yet — the CLI writes that file a moment later. The first fetch after a
  // launch used to 404 on it, which left a red line in the console on every
  // single launch.
  it('GET /api/sessions/:id/messages returns an empty transcript for a session with no file yet', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messages: [] });
  });

  it('GET /api/sessions/:id/messages still 404s for a session nobody has heard of', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/does-not-exist/messages' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not found' });
  });

  it('POST /api/sessions starts a web session via the runner', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: 'web-9' });
  });

  it('POST /api/sessions expands a ~ cwd before the runner and the row see it', async () => {
    // The New Session dialog prefills its directory field from
    // `default_project_dir`, a hand-typed setting that routinely holds
    // `~/...`. A literal tilde reaches the SDK as a directory that does not
    // exist: the spawn fails with ENOENT inside the runner's pump, and the
    // user is left with a session row whose session never ran.
    const { app, db, startCalls } = makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '~/Projects/slothworks/atlas', prompt: 'go', permissionMode: 'acceptEdits' },
    });
    expect(res.statusCode).toBe(201);
    expect(startCalls[0].cwd).toBe(`${homedir()}/Projects/slothworks/atlas`);
    // Stored expanded too, or `/api/projects` lists the same directory twice,
    // once per spelling, and the per-project model memory splits with it.
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'web-9')).get() as SessionRow;
    expect(row.cwd).toBe(`${homedir()}/Projects/slothworks/atlas`);
  });

  // `auto` is the SDK's unattended mode, added to Orbital's union with the
  // permission-mode dots. The column is untyped text, so nothing but this
  // test catches the union and the route body type drifting apart again.
  it('POST /api/sessions accepts auto and round-trips it onto the row', async () => {
    const { app, db, startCalls } = makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/p', prompt: 'go', permissionMode: 'auto' },
    });
    expect(res.statusCode).toBe(201);
    expect(startCalls[0].permissionMode).toBe('auto');
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'web-9')).get() as SessionRow;
    expect(row.permission_mode).toBe('auto');
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

  it('stores the requested model when launching a session', async () => {
    const { app, db, startCalls } = makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/w/z', prompt: 'go', permissionMode: 'acceptEdits', model: 'opus[1m]' },
    });
    expect(res.statusCode).toBe(201);
    expect(startCalls[0].model).toBe('opus[1m]');
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'web-9')).get() as SessionRow;
    expect(row.model).toBe('opus[1m]');
  });

  it('exposes model and resolvedModel on the API shape', async () => {
    const { app, db } = makeApp();
    db.update(sessions).set({ model: 'sonnet', resolvedModel: 'claude-sonnet-5' }).where(eq(sessions.id, 's1')).run();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
    expect(res.json().session).toMatchObject({ model: 'sonnet', resolvedModel: 'claude-sonnet-5' });
  });

  it('POST /sessions/:id/messages revives an ended session via resume', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s2/messages', payload: { text: 'wake up' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, revived: true });
    expect(startCalls.at(-1)).toMatchObject({ resume: 's2', prompt: 'wake up', cwd: '/w/y' });
  });

  it('revives a session on the model it was launched with', async () => {
    const { app, db, startCalls } = makeApp();
    db.update(sessions).set({ model: 'haiku' }).where(eq(sessions.id, 's2')).run();
    await app.inject({ method: 'POST', url: '/api/sessions/s2/messages', payload: { text: 'again' } });
    expect(startCalls[0]).toMatchObject({ resume: 's2', model: 'haiku' });
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
    publishLiveSession({ hub, db, registry: registry as any, runner: runner as any, subagents }, live);
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
    publishLiveSession({ hub, db, registry: registry as any, runner: runner as any, subagents }, live);
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

  it('clear + startNew uses the settings default model, not the parent one', async () => {
    const { app, db, startCalls } = makeApp();
    db.update(sessions).set({ model: 'haiku', source: 'web' }).where(eq(sessions.id, 's2')).run();
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { default_model: 'sonnet' } });
    await app.inject({ method: 'POST', url: '/api/sessions/s2/clear', payload: { startNew: true } });
    expect(startCalls[0].model).toBe('sonnet');
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'web-9')).get() as SessionRow;
    expect(row.model).toBe('sonnet');
  });

  it('switches the model of a live session', async () => {
    const { app, db, runner } = makeApp();
    const calls: Array<[string, string]> = [];
    (runner as any).setModel = async (id: string, model: string) => { calls.push([id, model]); };
    (runner as any).status = (id: string) => (id === 's2' ? 'needs_input' : undefined);
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: { model: 'haiku' } });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([['s2', 'haiku']]);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
    expect(row.model).toBe('haiku');
  });

  it('records the model of an ended session without touching the runner', async () => {
    const { app, db, runner } = makeApp();
    let called = false;
    (runner as any).setModel = async () => { called = true; };
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: { model: 'sonnet' } });
    expect(res.statusCode).toBe(200);
    expect(called).toBe(false);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
    expect(row.model).toBe('sonnet');
  });

  it('refuses to switch a session that is live in a terminal', async () => {
    const { app, db } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s1/model', payload: { model: 'haiku' } });
    expect(res.statusCode).toBe(409);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's1')).get() as SessionRow;
    expect(row.model).toBeNull();
  });

  it('404s for an unknown session', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/nope/model', payload: { model: 'haiku' } });
    expect(res.statusCode).toBe(404);
  });

  it('400s on a missing or non-string model rather than clearing the row', async () => {
    const { app, db } = makeApp();
    db.update(sessions).set({ model: 'haiku' }).where(eq(sessions.id, 's2')).run();

    const missing = await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: {} });
    expect(missing.statusCode).toBe(400);

    const wrongType = await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: { model: 42 } });
    expect(wrongType.statusCode).toBe(400);

    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
    expect(row.model).toBe('haiku');
  });

  it('publishes an upsert after a switch', async () => {
    const { app, hub, runner } = makeApp();
    (runner as any).setModel = async () => {};
    const received = subscribeFake(hub, 'sessions');
    await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: { model: 'haiku' } });
    expect(received.at(-1).session).toMatchObject({ id: 's2', model: 'haiku' });
  });

  it('reports each project with the model its newest session used', async () => {
    const { app, db } = makeApp();
    db.update(sessions).set({ model: 'opus[1m]' }).where(eq(sessions.id, 's1')).run();
    db.update(sessions).set({ model: null, resolvedModel: 'claude-haiku-4-5-20251001' }).where(eq(sessions.id, 's2')).run();
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.json().projects).toEqual([
      { cwd: '/w/x', lastModel: 'opus[1m]' },
      { cwd: '/w/y', lastModel: 'claude-haiku-4-5-20251001' },
    ]);
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
// POST /api/sessions with an id the browser minted (it subscribes first)
// ---------------------------------------------------------------------------

describe('POST /api/sessions with a browser-minted session id', () => {
  const CLIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const SERVER_MINTED = '8c2a1f6e-7b3d-4c5a-9e1f-2a3b4c5d6e7f';

  /** SDK fake that parks on stdin: the session stays alive and says nothing. */
  const idleSdk = ({ prompt }: any) => {
    async function* gen(): AsyncGenerator<any> {
      for await (const _msg of prompt) { /* take the turn, answer nothing */ }
    }
    return gen() as any;
  };

  // A real Runner, not the fake at the top of this file: the point of the
  // 400 case is that no CLI was spawned, and a fake whose `active()` is a
  // hardcoded `[]` could never show that.
  function makeLaunchApp() {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'orbital-mint-')), 'index.db'));
    const hub = new Hub();
    const runner = new Runner({
      hub, queryFn: idleSdk as any, newSessionId: () => SERVER_MINTED,
    });
    const app = Fastify();
    registerRoutes(app, {
      db,
      registry: { get: () => undefined, all: () => [] } as any,
      runner,
      projectsDir: '/nonexistent',
      hub,
      models: { list: async () => [], recordContextWindows: () => {} } as any,
      subagents: new SubagentStore(),
      errors: new ErrorLog({ db, hub }),
      settings: { get: () => '', set: () => {} },
    });
    return { app, db, runner, hub, close: () => { runner.dispose(); db.$client.close(); } };
  }

  const launch = (app: FastifyInstance, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits', ...payload },
    });

  it('creates the session under exactly the id the browser sent', async () => {
    const { app, db, runner, close } = makeLaunchApp();
    const res = await launch(app, { sessionId: CLIENT_ID });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: CLIENT_ID });
    // The row, the runner and the topic the browser is already sitting on
    // all name the same session — which is the entire point.
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, CLIENT_ID)).get() as SessionRow;
    expect(row).toBeDefined();
    expect(row.source).toBe('web');
    expect(runner.status(CLIENT_ID)).toBeDefined();
    expect(runner.active()).toEqual([CLIENT_ID]);
    close();
  });

  // Not a UUID at all, a v1 UUID (the CLI takes no other shape than v4), and
  // an empty string — which is *present* and wrong, not absent.
  for (const [label, sessionId] of [
    ['not a UUID', 'my-favourite-session'],
    ['a v1 UUID', '2c1e4f7a-9c1b-11ee-b9d1-0242ac120002'],
    ['an empty string', ''],
  ] as const) {
    it(`400s on ${label} and starts nothing`, async () => {
      const { app, db, runner, close } = makeLaunchApp();
      const res = await launch(app, { sessionId });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'sessionId must be a v4 UUID' });
      // The worst outcome here would be a 400 that still spawned a CLI: a
      // running session nothing in the UI can ever name.
      expect(runner.active()).toEqual([]);
      expect(db.select(sessionColumns).from(sessions).all()).toEqual([]);
      close();
    });
  }

  it('409s when a row already holds that id', async () => {
    const { app, db, runner, close } = makeLaunchApp();
    db.insert(sessions)
      .values({ id: CLIENT_ID, projectDir: 'p', cwd: '/w/x', lastAt: 1, source: 'terminal' })
      .run();
    const res = await launch(app, { sessionId: CLIENT_ID });
    expect(res.statusCode).toBe(409);
    expect(runner.active()).toEqual([]);
    close();
  });

  it('409s when the runner is already running that id', async () => {
    const { app, runner, close } = makeLaunchApp();
    // Live in the runner but with no row of its own — the sessions table
    // alone would have said this id was free.
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'plan', sessionId: CLIENT_ID });
    const res = await launch(app, { sessionId: CLIENT_ID });
    expect(res.statusCode).toBe(409);
    expect(runner.active()).toEqual([CLIENT_ID]);
    close();
  });

  it('mints server-side when the body carries no sessionId at all', async () => {
    const { app, db, runner, close } = makeLaunchApp();
    const res = await launch(app, {});
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: SERVER_MINTED });
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, SERVER_MINTED)).get() as SessionRow;
    expect(row).toBeDefined();
    expect(runner.active()).toEqual([SERVER_MINTED]);
    close();
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
      subagents: new SubagentStore(),
      errors: new ErrorLog({ db, hub }),
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

// ---------------------------------------------------------------------------
// The error log (docs/superpowers/specs/2026-09-17-error-surface-design.md)
// ---------------------------------------------------------------------------

describe('error log routes', () => {
  let app: FastifyInstance;
  let hub: Hub;
  let errors: ErrorLog;
  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    hub = result.hub;
    errors = result.errors;
  });

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/errors', payload: payload as any });

  it('GET /api/errors returns rows newest first with the whole-table unseen count', async () => {
    for (const message of ['one', 'two', 'three']) {
      errors.record({ source: 'server', kind: 'session_failed', message });
    }
    const body = (await app.inject({ method: 'GET', url: '/api/errors' })).json();
    expect(body.errors.map((e: any) => e.message)).toEqual(['three', 'two', 'one']);
    expect(body.unseen).toBe(3);
  });

  it('GET /api/errors pages with limit and before, and unseen stays the total', async () => {
    for (let i = 0; i < 5; i++) {
      errors.record({ source: 'server', kind: 'session_failed', message: `e${i}` });
    }
    const first = (await app.inject({ method: 'GET', url: '/api/errors?limit=2' })).json();
    expect(first.errors.map((e: any) => e.message)).toEqual(['e4', 'e3']);
    // Not 2: the count is of the table, not of the page.
    expect(first.unseen).toBe(5);
    const next = (
      await app.inject({ method: 'GET', url: `/api/errors?limit=2&before=${first.errors[1].id}` })
    ).json();
    expect(next.errors.map((e: any) => e.message)).toEqual(['e2', 'e1']);
  });

  it('POST /api/errors records the browser\'s own failure and publishes it', async () => {
    const received = subscribeFake(hub, 'errors');
    const res = await post({
      kind: 'api_request',
      message: 'rename failed',
      detail: 'HTTP 500\n{"error":"boom"}',
      context: { url: '/api/sessions/s1', status: 500 },
      sessionId: 's1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toMatchObject({
      source: 'web',
      kind: 'api_request',
      message: 'rename failed',
      sessionId: 's1',
      context: { url: '/api/sessions/s1', status: 500 },
      seenAt: null,
    });
    expect(body.unseen).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ topic: 'errors', event: 'error', unseen: 1 });
    expect(received[0].error.message).toBe('rename failed');
  });

  it('POST /api/errors cannot be told it came from the server', async () => {
    const body = (await post({ source: 'server', kind: 'render_crash', message: 'boom' })).json();
    expect(body.error.source).toBe('web');
    const listed = (await app.inject({ method: 'GET', url: '/api/errors' })).json();
    expect(listed.errors[0].source).toBe('web');
  });

  it('POST /api/errors rejects a missing message and an unknown kind', async () => {
    const noMessage = await post({ kind: 'api_request', message: '   ' });
    expect(noMessage.statusCode).toBe(400);
    expect(noMessage.json()).toEqual({ error: 'message is required' });

    const badKind = await post({ kind: 'session_exploded', message: 'boom' });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json()).toEqual({ error: 'kind is invalid' });

    // Nothing was written by either attempt.
    expect((await app.inject({ method: 'GET', url: '/api/errors' })).json().errors).toEqual([]);
  });

  it('POST /api/errors/seen stamps a list of ids, then all of them', async () => {
    const ids = ['a', 'b', 'c'].map(
      (m) => errors.record({ source: 'server', kind: 'session_failed', message: m }).id,
    );
    const some = await app.inject({
      method: 'POST', url: '/api/errors/seen', payload: { ids: [ids[0]] },
    });
    expect(some.json()).toEqual({ ok: true, unseen: 2 });

    const all = await app.inject({
      method: 'POST', url: '/api/errors/seen', payload: { all: true },
    });
    expect(all.json()).toEqual({ ok: true, unseen: 0 });
    const listed = (await app.inject({ method: 'GET', url: '/api/errors' })).json();
    expect(listed.errors.every((e: any) => typeof e.seenAt === 'number')).toBe(true);
  });

  it('POST /api/errors/seen rejects a body that is neither ids nor all', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/errors/seen', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'ids must be an array of numbers' });
  });

  it('DELETE /api/errors empties the log and zeroes the count', async () => {
    errors.record({ source: 'server', kind: 'session_failed', message: 'gone' });
    const received = subscribeFake(hub, 'errors');
    const res = await app.inject({ method: 'DELETE', url: '/api/errors' });
    expect(res.json()).toEqual({ ok: true, unseen: 0 });
    expect(received[0]).toMatchObject({ topic: 'errors', event: 'cleared' });
    expect((await app.inject({ method: 'GET', url: '/api/errors' })).json()).toEqual({
      errors: [], unseen: 0,
    });
  });
});
