import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, entriesToMessages } from '../transcript/parser.js';
import { effectiveTagIds, regenerateRuleTags, matchRule } from '../tags/rules.js';
import type { Runner } from '../runner/runner.js';
import type { SessionRegistry } from '../watcher/registry.js';
import type { Hub } from './hub.js';
import type { SessionRow, SessionStatus, TagRule } from '../types.js';

export interface RouteContext {
  db: Database.Database;
  registry: SessionRegistry;
  runner: Runner;
  projectsDir: string;
  hub: Hub;
  settings: { get(key: string): string; set(key: string, value: string): void };
}

function statusOf(ctx: RouteContext, row: SessionRow): SessionStatus {
  const fromRunner = ctx.runner.status(row.id);
  if (fromRunner) return fromRunner;
  const live = ctx.registry.get(row.id);
  if (live) return live.status;
  return 'ended';
}

function toApi(ctx: RouteContext, row: SessionRow) {
  return {
    id: row.id, cwd: row.cwd, title: row.title,
    firstAt: row.first_at, lastAt: row.last_at,
    messageCount: row.message_count, source: row.source,
    permissionMode: row.permission_mode, parentId: row.parent_id,
    tagIds: effectiveTagIds(ctx.db, row.id),
    status: statusOf(ctx, row),
  };
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;

  app.get('/api/sessions', (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const offset = Number(q.offset ?? 0);
    let rows = db
      .prepare(`SELECT * FROM sessions ORDER BY last_at DESC LIMIT ? OFFSET ?`)
      .all(limit * 4 + offset, 0) as SessionRow[]; // over-fetch, filter, then page
    if (q.source) rows = rows.filter((r) => r.source === q.source);
    if (q.q) rows = rows.filter((r) => r.title.toLowerCase().includes(q.q.toLowerCase()));
    let sessions = rows.map((r) => toApi(ctx, r));
    if (q.tag) sessions = sessions.filter((s) => s.tagIds.includes(Number(q.tag)));
    return { sessions: sessions.slice(offset, offset + limit) };
  });

  app.get('/api/sessions/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id) as SessionRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const lineage: string[] = [];
    let cursor: string | null = row.parent_id;
    while (cursor) {
      lineage.push(cursor);
      const parent = db.prepare(`SELECT parent_id FROM sessions WHERE id=?`).get(cursor) as
        | { parent_id: string | null } | undefined;
      cursor = parent?.parent_id ?? null;
    }
    return { session: toApi(ctx, row), lineage };
  });

  app.get('/api/sessions/:id/messages', (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const row = db.prepare(`SELECT project_dir FROM sessions WHERE id=?`).get(id) as
      | { project_dir: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    let messages;
    try {
      const text = readFileSync(join(ctx.projectsDir, row.project_dir, `${id}.jsonl`), 'utf8');
      messages = entriesToMessages(parseTranscript(text));
    } catch {
      return reply.code(404).send({ error: 'transcript missing' });
    }
    const limit = Math.min(Number(q.limit ?? 100), 500);
    const before = q.before ? messages.findIndex((m) => m.id === q.before) : messages.length;
    const end = before === -1 ? messages.length : before;
    return { messages: messages.slice(Math.max(0, end - limit), end) };
  });

  app.post('/api/sessions', async (req, reply) => {
    const body = req.body as {
      cwd: string; prompt: string; permissionMode: 'plan' | 'acceptEdits' | 'bypassPermissions';
      tagId?: number; model?: string; resume?: string; parentId?: string;
    };
    const sessionId = await ctx.runner.start(body);
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id, project_dir, cwd, source, permission_mode, parent_id, last_at)
       VALUES (?, '', ?, 'web', ?, ?, ?)`,
    ).run(sessionId, body.cwd, body.permissionMode, body.parentId ?? null, Date.now());
    if (body.tagId != null) {
      db.prepare(`INSERT OR IGNORE INTO session_tags VALUES (?, ?, 'manual')`).run(sessionId, body.tagId);
    }
    const row = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(sessionId) as SessionRow;
    ctx.hub.publish('sessions', { event: 'upsert', session: toApi(ctx, row) });
    return reply.code(201).send({ sessionId });
  });

  app.post('/api/sessions/:id/messages', (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = req.body as { text: string };
    try {
      ctx.runner.send(id, text);
    } catch {
      return reply.code(409).send({ error: 'session not active; use POST /api/sessions with resume' });
    }
    return { ok: true };
  });

  app.post('/api/sessions/:id/interrupt', async (req) => {
    await ctx.runner.interrupt((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post('/api/sessions/:id/clear', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { startNew } = (req.body ?? {}) as { startNew?: boolean };
    const row = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id) as SessionRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    await ctx.runner.end(id);
    if (!startNew) return { ok: true };
    const inheritMode = ctx.settings.get('inherit_permission_mode') === 'true';
    const permissionMode = (inheritMode && row.permission_mode
      ? row.permission_mode
      : ctx.settings.get('default_permission_mode')) as any;
    const newId = await ctx.runner.start({
      cwd: row.cwd, prompt: '',
      permissionMode,
    });
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id, project_dir, cwd, source, permission_mode, parent_id, last_at)
       VALUES (?, '', ?, 'web', ?, ?, ?)`,
    ).run(newId, row.cwd, permissionMode, id, Date.now());
    if (ctx.settings.get('inherit_tags') === 'true') {
      db.prepare(
        `INSERT OR IGNORE INTO session_tags (session_id, tag_id, origin)
         SELECT ?, tag_id, 'manual' FROM session_tags WHERE session_id=? AND origin='manual'`,
      ).run(newId, id);
    }
    return { ok: true, sessionId: newId };
  });

  app.patch('/api/sessions/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    const { title } = req.body as { title: string };
    const result = db.prepare(`UPDATE sessions SET title=? WHERE id=?`).run(title, id);
    if (result.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.put('/api/sessions/:id/tags', (req) => {
    const { id } = req.params as { id: string };
    const { tagIds } = req.body as { tagIds: number[] };
    const current = new Set(
      (db.prepare(`SELECT tag_id FROM session_tags WHERE session_id=? AND origin='rule'`)
        .all(id) as Array<{ tag_id: number }>).map((r) => r.tag_id),
    );
    db.transaction(() => {
      db.prepare(`DELETE FROM session_tags WHERE session_id=? AND origin IN ('manual','manual_removed')`).run(id);
      for (const tagId of tagIds) {
        if (!current.has(tagId)) {
          db.prepare(`INSERT OR IGNORE INTO session_tags VALUES (?, ?, 'manual')`).run(id, tagId);
        }
      }
      for (const ruleTag of current) {
        if (!tagIds.includes(ruleTag)) {
          db.prepare(`INSERT OR IGNORE INTO session_tags VALUES (?, ?, 'manual_removed')`).run(id, ruleTag);
        }
      }
    })();
    // A removed rule-derived tag leaves its 'rule' origin row in place unless
    // we regenerate — without this, effectiveTagIds (which unions rule+manual)
    // would keep showing the tag until an unrelated rule mutation happened to
    // run regenerateRuleTags. See spec finding C1.
    regenerateRuleTags(db);
    return { ok: true };
  });

  app.get('/api/tags', () => ({
    tags: db.prepare(`SELECT * FROM tags ORDER BY id`).all(),
  }));
  app.post('/api/tags', (req, reply) => {
    const { name, hue } = req.body as { name: string; hue: number };
    const r = db.prepare(`INSERT INTO tags (name, hue) VALUES (?, ?)`).run(name, hue);
    return reply.code(201).send({ id: Number(r.lastInsertRowid) });
  });
  app.patch('/api/tags/:id', (req) => {
    const { id } = req.params as { id: string };
    const { name, hue } = req.body as { name?: string; hue?: number };
    if (name != null) db.prepare(`UPDATE tags SET name=? WHERE id=?`).run(name, id);
    if (hue != null) db.prepare(`UPDATE tags SET hue=? WHERE id=?`).run(hue, id);
    return { ok: true };
  });
  app.delete('/api/tags/:id', (req) => {
    db.prepare(`DELETE FROM tags WHERE id=? AND is_default=0`).run((req.params as any).id);
    regenerateRuleTags(db);
    return { ok: true };
  });

  app.get('/api/tag-rules', () => ({
    rules: db.prepare(`SELECT * FROM tag_rules ORDER BY position`).all(),
  }));
  app.post('/api/tag-rules', (req, reply) => {
    const { tagId, condition, pattern } = req.body as {
      tagId: number; condition: TagRule['condition']; pattern: string;
    };
    const max = (db.prepare(`SELECT COALESCE(MAX(position),-1) m FROM tag_rules`).get() as any).m;
    const r = db.prepare(
      `INSERT INTO tag_rules (tag_id, position, enabled, condition, pattern) VALUES (?, ?, 1, ?, ?)`,
    ).run(tagId, max + 1, condition, pattern);
    regenerateRuleTags(db);
    return reply.code(201).send({ id: Number(r.lastInsertRowid) });
  });
  app.patch('/api/tag-rules/:id', (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<Pick<TagRule, 'position' | 'enabled' | 'condition' | 'pattern' | 'tag_id'>>;
    for (const key of ['position', 'enabled', 'condition', 'pattern', 'tag_id'] as const) {
      if (body[key] != null) db.prepare(`UPDATE tag_rules SET ${key}=? WHERE id=?`).run(body[key], id);
    }
    regenerateRuleTags(db);
    return { ok: true };
  });
  app.delete('/api/tag-rules/:id', (req) => {
    db.prepare(`DELETE FROM tag_rules WHERE id=?`).run((req.params as any).id);
    regenerateRuleTags(db);
    return { ok: true };
  });
  app.post('/api/tag-rules/preview', (req) => {
    const body = req.body as { cwd: string; title: string; permissionMode: string | null };
    const rules = db.prepare(`SELECT * FROM tag_rules ORDER BY position`).all() as TagRule[];
    const rule = matchRule(rules, body);
    return rule ? { tagId: rule.tag_id, ruleId: rule.id } : { tagId: null, ruleId: null };
  });

  app.get('/api/projects', () => {
    const rows = db
      .prepare(`SELECT cwd FROM sessions WHERE cwd != '' GROUP BY cwd ORDER BY MAX(last_at) DESC LIMIT 50`)
      .all() as Array<{ cwd: string }>;
    return { projects: rows.map((r) => r.cwd) };
  });

  app.get('/api/settings', () => {
    const rows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });
  app.patch('/api/settings', (req) => {
    for (const [k, v] of Object.entries(req.body as Record<string, string>)) {
      ctx.settings.set(k, String(v));
    }
    return { ok: true };
  });
}
