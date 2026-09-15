import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { registerRoutes } from '../src/api/routes.js';
import { buildServer } from '../src/index.js';

function makeApp() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'orbital-api-')), 'index.db'));
  db.prepare(`INSERT INTO tags (id, name, hue) VALUES (10, 'work', 210)`).run();
  db.prepare(
    `INSERT INTO sessions (id, project_dir, cwd, title, last_at, source, permission_mode)
     VALUES ('s1','p','/w/x','auth fix', 200, 'terminal', 'acceptEdits'),
            ('s2','p','/w/y','recipe', 100, 'terminal', NULL)`,
  ).run();
  db.prepare(`INSERT INTO session_tags VALUES ('s1', 10, 'manual')`).run();
  const registry = {
    get: (id: string) => (id === 's1' ? { sessionId: 's1', status: 'working' } : undefined),
    all: () => [{ sessionId: 's1', status: 'working' }],
  };
  const runner = {
    status: () => undefined, active: () => [],
    start: async () => 'web-9', send: () => {}, interrupt: async () => {}, end: async () => {},
  };
  const app = Fastify();
  registerRoutes(app, {
    db, registry: registry as any, runner: runner as any, projectsDir: '/nonexistent',
    settings: {
      get: (k: string) => (db.prepare(`SELECT value FROM settings WHERE key=?`).get(k) as any)?.value ?? '',
      set: (k: string, v: string) =>
        db.prepare(`INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v),
    },
  });
  return { app, db, runner };
}

describe('REST routes', () => {
  let app: FastifyInstance;
  let db: any;
  let runner: any;
  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    db = result.db;
    runner = result.runner;
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
    const newSession = db.prepare(`SELECT permission_mode, parent_id FROM sessions WHERE id=?`).get('web-10') as any;
    expect(newSession.permission_mode).toBe('plan');
    expect(newSession.parent_id).toBe('s1');

    // Verify manual tags are NOT copied (inherit_tags=false)
    const tags = db.prepare(`SELECT tag_id FROM session_tags WHERE session_id=?`).all('web-10') as any[];
    expect(tags).toHaveLength(0);

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
    const copiedTags = db.prepare(`SELECT tag_id FROM session_tags WHERE session_id=?`).all(newSessionId) as any[];
    expect(copiedTags).toHaveLength(1);
    expect(copiedTags[0].tag_id).toBe(10);
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
