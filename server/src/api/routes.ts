import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, entriesToMessages } from '../transcript/parser.js';
import { regenerateRuleTags, matchRule } from '../tags/rules.js';
import { expandHome } from '../paths.js';
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
import type { SubagentStore } from '../transcript/subagents.js';
import type { ErrorKind, PermissionMode, SessionRow, TagRule } from '../types.js';
import type { ModelCatalog } from '../models/catalog.js';
import type { ErrorLog } from '../errors/log.js';

export interface RouteContext {
  db: OrbitalDb;
  registry: SessionRegistry;
  runner: Runner;
  projectsDir: string;
  hub: Hub;
  models: ModelCatalog;
  subagents: SubagentStore;
  errors: ErrorLog;
  settings: { get(key: string): string; set(key: string, value: string): void };
}

/** The only kinds `POST /api/errors` will accept, mirroring `ErrorKind`. */
const ERROR_KINDS = new Set<string>(['session_failed', 'api_request', 'render_crash']);

/**
 * A v4 UUID in the one spelling `randomUUID()` produces: lowercase hex, `4`
 * opening the third group, `8`/`9`/`a`/`b` opening the fourth.
 *
 * This is the only shape the CLI accepts as `options.sessionId`
 * (`docs/decisions/runner-pins-the-session-id.md`), and it is what the server
 * has always minted — so a client-supplied id is held to exactly the same
 * standard rather than being trusted as an opaque string. Uppercase is
 * rejected too: `crypto.randomUUID()` never emits it in either runtime, and
 * the id goes on to be a primary key, a WS topic and a filename, each of
 * which would treat the two spellings as two different sessions.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
      // Two different "missing"s, and only one of them is a 404. An unknown
      // id already left above — that session does not exist. Getting here
      // means the row does exist and only the file is absent, which is the
      // ordinary state of a session Orbital has just launched: the row goes
      // in with `project_dir: ''` and the CLI writes the transcript a moment
      // later. A session with nothing written yet has an empty transcript,
      // not a missing one, so say so instead of 404ing every launch.
      return { messages: [] };
    }
    const limit = Math.min(Number(q.limit ?? 100), 500);
    const before = q.before ? messages.findIndex((m) => m.id === q.before) : messages.length;
    const end = before === -1 ? messages.length : before;
    return { messages: messages.slice(Math.max(0, end - limit), end) };
  });

  app.post('/api/sessions', async (req, reply) => {
    const body = req.body as {
      cwd: string; prompt: string; permissionMode: PermissionMode;
      tagId?: number; model?: string; resume?: string; parentId?: string;
      sessionId?: string;
    };
    // The one door an unexpanded path comes through: every other cwd in this
    // file is read back from a row this line already wrote. Expanding before
    // both the runner and the insert keeps the spawn working *and* keeps one
    // directory from appearing twice in `/api/projects`, once per spelling.
    const cwd = expandHome(body.cwd);
    // The browser may mint the id itself and subscribe to `session:<id>`
    // before it posts this, so the first turn cannot be published into a
    // topic nobody is in yet. Optional: `clear` with `startNew` and every
    // other internal caller still lets the server mint. `null` counts as
    // absent; an empty string does not — that is a client that meant to send
    // an id and sent nothing.
    const clientId = body.sessionId ?? undefined;
    if (clientId !== undefined) {
      if (!SESSION_ID_RE.test(clientId)) {
        return reply.code(400).send({ error: 'sessionId must be a v4 UUID' });
      }
      // Both halves matter. A row alone would miss a session live in this
      // process whose row has not landed (or was deleted), and the runner
      // alone would miss every session from a previous boot. `status()` also
      // answers for sessions that have already ended, which is the answer we
      // want: their transcript still sits on disk under that name.
      const rowExists = db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, clientId))
        .get() !== undefined;
      if (rowExists || ctx.runner.status(clientId) !== undefined) {
        return reply.code(409).send({ error: 'session id is already taken' });
      }
    }
    const sessionId = await ctx.runner.start({ ...body, cwd, sessionId: clientId });
    db.insert(sessions)
      .values({
        id: sessionId, projectDir: '', cwd, source: 'web',
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

  // The error log. One table, fed from both sides — see
  // `docs/superpowers/specs/2026-09-17-error-surface-design.md`.
  app.get('/api/errors', (req) => {
    const q = req.query as Record<string, string>;
    return ctx.errors.list({
      limit: q.limit != null ? Number(q.limit) : undefined,
      before: q.before != null ? Number(q.before) : undefined,
    });
  });

  app.post('/api/errors', (req, reply) => {
    const body = (req.body ?? {}) as {
      kind?: unknown; message?: unknown; detail?: unknown;
      context?: unknown; sessionId?: unknown;
    };
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return reply.code(400).send({ error: 'message is required' });
    }
    if (typeof body.kind !== 'string' || !ERROR_KINDS.has(body.kind)) {
      return reply.code(400).send({ error: 'kind is invalid' });
    }
    const error = ctx.errors.record({
      // Not read from the body, ever. This endpoint is how the *browser*
      // reports, and a `web` row that claims to be a `server` one would make
      // the log lie about where a failure was caught.
      source: 'web',
      kind: body.kind as ErrorKind,
      message: body.message,
      detail: typeof body.detail === 'string' ? body.detail : null,
      context:
        body.context && typeof body.context === 'object'
          ? (body.context as Record<string, unknown>)
          : null,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    });
    return { error, unseen: ctx.errors.unseen() };
  });

  app.post('/api/errors/seen', (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
    if (body.all === true) return { ok: true, ...ctx.errors.markSeen('all') };
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'number')) {
      return reply.code(400).send({ error: 'ids must be an array of numbers' });
    }
    return { ok: true, ...ctx.errors.markSeen(body.ids as number[]) };
  });

  app.delete('/api/errors', () => {
    ctx.errors.clear();
    return { ok: true, unseen: 0 };
  });

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
