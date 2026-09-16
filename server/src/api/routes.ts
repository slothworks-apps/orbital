import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, entriesToMessages } from '../transcript/parser.js';
import { regenerateRuleTags, matchRule } from '../tags/rules.js';
import type { OrbitalDb } from '../db/database.js';
import {
  sessionColumns,
  sessions,
  sessionTags,
  settings as settingsTable,
  tagColumns,
  tagRuleColumns,
  tagRules,
  tags,
} from '../db/schema.js';
import { parseIdleTimeoutMs, type Runner } from '../runner/runner.js';
import type { SessionRegistry } from '../watcher/registry.js';
import type { Hub } from './hub.js';
import { toApiSession } from './shape.js';
import type { PermissionMode, SessionRow, TagRule } from '../types.js';
import type { ModelCatalog } from '../models/catalog.js';

export interface RouteContext {
  db: OrbitalDb;
  registry: SessionRegistry;
  runner: Runner;
  projectsDir: string;
  hub: Hub;
  models: ModelCatalog;
  settings: { get(key: string): string; set(key: string, value: string): void };
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;

  app.get('/api/sessions', (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const offset = Number(q.offset ?? 0);
    let rows = db
      .select(sessionColumns)
      .from(sessions)
      .orderBy(desc(sessions.lastAt))
      .limit(limit * 4 + offset) // over-fetch, filter, then page
      .all() as SessionRow[];
    if (q.source) rows = rows.filter((r) => r.source === q.source);
    if (q.q) rows = rows.filter((r) => r.title.toLowerCase().includes(q.q.toLowerCase()));
    let sessionsOut = rows.map((r) => toApiSession(ctx, r));
    if (q.tag) sessionsOut = sessionsOut.filter((s) => s.tagIds.includes(Number(q.tag)));
    return { sessions: sessionsOut.slice(offset, offset + limit) };
  });

  app.get('/api/sessions/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as
      | SessionRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const lineage: string[] = [];
    let cursor: string | null = row.parent_id;
    while (cursor) {
      lineage.push(cursor);
      const parent = db
        .select({ parent_id: sessions.parentId })
        .from(sessions)
        .where(eq(sessions.id, cursor))
        .get() as { parent_id: string | null } | undefined;
      cursor = parent?.parent_id ?? null;
    }
    return { session: toApiSession(ctx, row), lineage };
  });

  app.get('/api/sessions/:id/messages', (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const row = db
      .select({ project_dir: sessions.projectDir })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get() as { project_dir: string } | undefined;
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
    db.insert(sessions)
      .values({
        id: sessionId, projectDir: '', cwd: body.cwd, source: 'web',
        permissionMode: body.permissionMode, model: body.model ?? null,
        parentId: body.parentId ?? null, lastAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    if (body.tagId != null) {
      db.insert(sessionTags)
        .values({ sessionId, tagId: body.tagId, origin: 'manual' })
        .onConflictDoNothing()
        .run();
    }
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, sessionId)).get() as SessionRow;
    ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, row) });
    return reply.code(201).send({ sessionId });
  });

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = req.body as { text: string };
    try {
      ctx.runner.send(id, text);
      return { ok: true };
    } catch {
      // Inactive in the runner — revive by resuming, unless it's live in a
      // terminal (which owns the SDK process and can't be taken over).
      const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as
        | SessionRow
        | undefined;
      if (!row) return reply.code(404).send({ error: 'not found' });
      if (ctx.registry.get(id)) {
        return reply.code(409).send({ error: 'session is live in a terminal' });
      }
      const permissionMode = (row.permission_mode ??
        ctx.settings.get('default_permission_mode')) as PermissionMode;
      await ctx.runner.start({
        cwd: row.cwd, prompt: text, permissionMode, resume: id,
        // Without this, reviving silently moved the session onto the CLI's
        // default model.
        model: row.model ?? undefined,
      });
      const revivedRow = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
      ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, revivedRow) });
      return { ok: true, revived: true };
    }
  });

  app.post('/api/sessions/:id/interrupt', async (req) => {
    await ctx.runner.interrupt((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post('/api/sessions/:id/model', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { model } = (req.body ?? {}) as { model?: unknown };
    if (typeof model !== 'string' || !model) {
      return reply.code(400).send({ error: 'model is required' });
    }
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as
      | SessionRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    // A session the terminal owns is not ours to reconfigure — the same rule
    // that stops us from sending it messages.
    if (ctx.registry.get(id)) {
      return reply.code(409).send({ error: 'session is live in a terminal' });
    }
    if (ctx.runner.status(id) && ctx.runner.status(id) !== 'ended') {
      await ctx.runner.setModel(id, model);
    }
    // An ended session keeps the choice too: it is what the revive resumes on.
    db.update(sessions).set({ model }).where(eq(sessions.id, id)).run();
    const updated = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
    ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, updated) });
    return { ok: true };
  });

  app.post('/api/sessions/:id/clear', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { startNew } = (req.body ?? {}) as { startNew?: boolean };
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as
      | SessionRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    await ctx.runner.end(id);
    if (!startNew) return { ok: true };
    const inheritMode = ctx.settings.get('inherit_permission_mode') === 'true';
    const permissionMode = (inheritMode && row.permission_mode
      ? row.permission_mode
      : ctx.settings.get('default_permission_mode')) as any;
    // 4c: the default model is "used by Clear". Deliberately unlike
    // permission mode, there is no inherit toggle — the canvas does not ask
    // for one.
    const model = ctx.settings.get('default_model') || undefined;
    const newId = await ctx.runner.start({
      cwd: row.cwd, prompt: '',
      permissionMode, model,
    });
    db.insert(sessions)
      .values({
        id: newId, projectDir: '', cwd: row.cwd, source: 'web',
        permissionMode, model: model ?? null, parentId: id, lastAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    if (ctx.settings.get('inherit_tags') === 'true') {
      db.insert(sessionTags)
        .select(
          db
            .select({
              sessionId: sql<string>`${newId}`.as('sessionId'),
              tagId: sessionTags.tagId,
              origin: sql<string>`'manual'`.as('origin'),
            })
            .from(sessionTags)
            .where(and(eq(sessionTags.sessionId, id), eq(sessionTags.origin, 'manual'))),
        )
        .onConflictDoNothing()
        .run();
    }
    const newRow = db.select(sessionColumns).from(sessions).where(eq(sessions.id, newId)).get() as SessionRow;
    ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, newRow) });
    return { ok: true, sessionId: newId };
  });

  app.patch('/api/sessions/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    const { title } = req.body as { title: string };
    const result = db.update(sessions).set({ title }).where(eq(sessions.id, id)).run();
    if (result.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.put('/api/sessions/:id/tags', (req) => {
    const { id } = req.params as { id: string };
    const { tagIds } = req.body as { tagIds: number[] };
    const current = new Set(
      db
        .select({ tag_id: sessionTags.tagId })
        .from(sessionTags)
        .where(and(eq(sessionTags.sessionId, id), eq(sessionTags.origin, 'rule')))
        .all()
        .map((r) => r.tag_id),
    );
    db.transaction((tx) => {
      tx.delete(sessionTags)
        .where(
          and(
            eq(sessionTags.sessionId, id),
            inArray(sessionTags.origin, ['manual', 'manual_removed']),
          ),
        )
        .run();
      for (const tagId of tagIds) {
        if (!current.has(tagId)) {
          tx.insert(sessionTags)
            .values({ sessionId: id, tagId, origin: 'manual' })
            .onConflictDoNothing()
            .run();
        }
      }
      for (const ruleTag of current) {
        if (!tagIds.includes(ruleTag)) {
          tx.insert(sessionTags)
            .values({ sessionId: id, tagId: ruleTag, origin: 'manual_removed' })
            .onConflictDoNothing()
            .run();
        }
      }
    });
    // A removed rule-derived tag leaves its 'rule' origin row in place unless
    // we regenerate — without this, effectiveTagIds (which unions rule+manual)
    // would keep showing the tag until an unrelated rule mutation happened to
    // run regenerateRuleTags. See spec finding C1.
    regenerateRuleTags(db);
    return { ok: true };
  });

  app.get('/api/tags', () => ({
    tags: db.select(tagColumns).from(tags).orderBy(tags.id).all(),
  }));
  app.post('/api/tags', (req, reply) => {
    const { name, hue } = req.body as { name: string; hue: number };
    const r = db.insert(tags).values({ name, hue }).run();
    return reply.code(201).send({ id: Number(r.lastInsertRowid) });
  });
  app.patch('/api/tags/:id', (req) => {
    const { id } = req.params as { id: string };
    const { name, hue } = req.body as { name?: string; hue?: number };
    const set: Partial<{ name: string; hue: number }> = {};
    if (name != null) set.name = name;
    if (hue != null) set.hue = hue;
    if (Object.keys(set).length > 0) {
      db.update(tags).set(set).where(eq(tags.id, Number(id))).run();
    }
    return { ok: true };
  });
  app.delete('/api/tags/:id', (req) => {
    const { id } = (req.params as any) as { id: string };
    db.delete(tags).where(and(eq(tags.id, Number(id)), eq(tags.isDefault, 0))).run();
    regenerateRuleTags(db);
    return { ok: true };
  });

  app.get('/api/tag-rules', () => ({
    rules: db.select(tagRuleColumns).from(tagRules).orderBy(tagRules.position).all(),
  }));
  app.post('/api/tag-rules', (req, reply) => {
    const { tagId, condition, pattern } = req.body as {
      tagId: number; condition: TagRule['condition']; pattern: string;
    };
    const maxRow = db
      .select({ m: sql<number>`COALESCE(MAX(${tagRules.position}), -1)` })
      .from(tagRules)
      .get() as { m: number };
    const r = db
      .insert(tagRules)
      .values({ tagId, position: maxRow.m + 1, enabled: 1, condition, pattern })
      .run();
    regenerateRuleTags(db);
    return reply.code(201).send({ id: Number(r.lastInsertRowid) });
  });
  app.patch('/api/tag-rules/:id', (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<Pick<TagRule, 'position' | 'enabled' | 'condition' | 'pattern' | 'tag_id'>>;
    const set: Partial<{
      position: number; enabled: 0 | 1; condition: TagRule['condition']; pattern: string; tagId: number;
    }> = {};
    if (body.position != null) set.position = body.position;
    if (body.enabled != null) set.enabled = body.enabled;
    if (body.condition != null) set.condition = body.condition;
    if (body.pattern != null) set.pattern = body.pattern;
    if (body.tag_id != null) set.tagId = body.tag_id;
    if (Object.keys(set).length > 0) {
      db.update(tagRules).set(set).where(eq(tagRules.id, Number(id))).run();
    }
    regenerateRuleTags(db);
    return { ok: true };
  });
  app.delete('/api/tag-rules/:id', (req) => {
    const { id } = (req.params as any) as { id: string };
    db.delete(tagRules).where(eq(tagRules.id, Number(id))).run();
    regenerateRuleTags(db);
    return { ok: true };
  });
  app.post('/api/tag-rules/preview', (req) => {
    const body = req.body as { cwd: string; title: string; permissionMode: string | null };
    const rules = db.select(tagRuleColumns).from(tagRules).orderBy(tagRules.position).all();
    const rule = matchRule(rules, body);
    return rule ? { tagId: rule.tag_id, ruleId: rule.id } : { tagId: null, ruleId: null };
  });

  app.get('/api/projects', () => {
    // Reduced in JS rather than grouped in SQL: the answer needs a *column
    // from* the newest row per cwd, not an aggregate of it, and first-seen
    // over a lastAt-ordered scan is the same thing without a correlated
    // subquery.
    const rows = db
      .select({
        cwd: sessions.cwd,
        model: sessions.model,
        resolvedModel: sessions.resolvedModel,
      })
      .from(sessions)
      .where(ne(sessions.cwd, ''))
      .orderBy(desc(sessions.lastAt))
      .limit(500)
      .all();
    const projects: Array<{ cwd: string; lastModel: string | null }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.cwd)) continue;
      seen.add(row.cwd);
      projects.push({ cwd: row.cwd, lastModel: row.model ?? row.resolvedModel ?? null });
      if (projects.length === 50) break;
    }
    return { projects };
  });

  app.get('/api/models', async () => ({ models: await ctx.models.list() }));

  app.get('/api/settings', () => {
    const rows = db.select().from(settingsTable).all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });
  app.patch('/api/settings', (req) => {
    for (const [k, v] of Object.entries(req.body as Record<string, string>)) {
      ctx.settings.set(k, String(v));
      // The idle timeout used to be read once at boot, so changing it here did
      // nothing until the API restarted. Push it straight into the Runner that
      // owns the timers instead — including already-idling sessions.
      if (k === 'ended_after_idle_minutes') {
        ctx.runner.setIdleTimeoutMs(parseIdleTimeoutMs(String(v)));
      }
    }
    return { ok: true };
  });
}
