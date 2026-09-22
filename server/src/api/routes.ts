import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, entriesToMessages } from '../transcript/parser.js';
import { regenerateRuleTags, matchRule } from '../tags/rules.js';
import { expandHome } from '../paths.js';
import { readFilePreview } from '../files/preview.js';
import { completeFilePath } from '../files/complete.js';
import { collectCommands } from '../commands/catalog.js';
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
import { decisionQuestions, parseIdleTimeoutMs, type Runner } from '../runner/runner.js';
import { RETENTION_KEY } from '../retention.js';
import type { SessionRegistry } from '../watcher/registry.js';
import type { Hub } from './hub.js';
import { toApiSession } from './shape.js';
import type { SubagentStore } from '../transcript/subagents.js';
import type { ChatMessage, ErrorKind, PermissionMode, SessionRow, TagRule } from '../types.js';
import type { ModelCatalog } from '../models/catalog.js';
import type { ErrorLog } from '../errors/log.js';
import type { ImageStore } from '../images/store.js';
import type { SessionTitler } from '../titler/titler.js';

export interface RouteContext {
  db: OrbitalDb;
  registry: SessionRegistry;
  runner: Runner;
  projectsDir: string;
  /** `~/.claude` — where the command catalog's user and plugin halves live
   * (spec: 2026-09-20-composer-design § Command catalog). */
  claudeDir: string;
  hub: Hub;
  /** Content-addressed transcript image store + the directory it serves
   * from (spec: 2026-09-18-transcript-images-design). */
  images: ImageStore;
  imagesDir: string;
  models: ModelCatalog;
  subagents: SubagentStore;
  errors: ErrorLog;
  /** Names a session from its own contents; here, only ever on demand. */
  titler: SessionTitler;
  settings: { get(key: string): string; set(key: string, value: string): void };
  /**
   * The retention sweep (spec 2026-09-21-settings-sections-design § 4).
   * Injected rather than called directly because the sweep has to publish a
   * `remove` per deleted session, and `buildServer` is what owns the hub and
   * the tombstone ordering against the indexer.
   */
  retention: {
    /** Runs the stored policy now, returning the ids it removed. */
    sweep(): string[];
    /** What a candidate policy WOULD remove, for the confirmation. */
    preview(value: string): number;
  };
}

/** The only kinds `POST /api/errors` will accept, mirroring `ErrorKind`. */
const ERROR_KINDS = new Set<string>(['session_failed', 'api_request', 'render_crash']);

/** Served type per stored extension (the store writes `jpg`, never `jpeg`). */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

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

/**
 * An image store ref, the same shape `GET /api/images/:ref` serves: 64
 * lowercase hex characters and a whitelisted extension. A composer attachment
 * is named by the client, so it is held to exactly this — nothing else can
 * traverse, and nothing else could have been written by the store.
 */
const IMAGE_REF_RE = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;

/**
 * The ceiling on one composer attachment.
 *
 * 5 MB rather than the canvas's 10: the Anthropic API caps an image source at
 * roughly this, so a larger upload would be accepted here and then fail a turn
 * later inside the SDK, where nothing can explain it. Refusing at intake is the
 * honest server fact — see the spec's Deviations.
 */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Whether a body's `attachments` is anything other than a list of refs the
 * image store could have written. Absent is fine — most turns have none.
 *
 * Held to `IMAGE_REF_RE` here rather than trusted and handed on: the refs come
 * from the client, and the Runner turns each one into a filesystem read.
 */
function invalidAttachments(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (!Array.isArray(raw)) return true;
  return raw.some((ref) => typeof ref !== 'string' || !IMAGE_REF_RE.test(ref));
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
      // Pinned rows first, in pin order, then the rest by recency. In the SQL
      // rather than a re-sort afterwards because this route over-fetches and
      // then slices a page out: a pinned row that sorted below the fetch
      // window would never reach the client at all, and the sidebar's
      // `offset: visible.length` arithmetic only stays valid while client
      // accumulation matches server order (spec
      // 2026-09-20-pinned-sessions-design § Server).
      .orderBy(sql`${sessions.pinnedAt} IS NULL`, sessions.pinnedAt, desc(sessions.lastAt))
      .limit(limit * 4 + offset) // over-fetch, filter, then page
      .all() as SessionRow[];
    if (q.source) rows = rows.filter((r) => r.source === q.source);
    if (q.q) rows = rows.filter((r) => r.title.toLowerCase().includes(q.q.toLowerCase()));
    let sessionsOut = rows.map((r) => toApiSession(ctx, r));
    if (q.tag) sessionsOut = sessionsOut.filter((s) => s.tagIds.includes(Number(q.tag)));
    return { sessions: sessionsOut.slice(offset, offset + limit) };
  });

  // The hole's label needs the whole index's size, and `GET /api/sessions`
  // only ever returns a page — so the total is its own tiny endpoint rather
  // than a reshaping of the list response every consumer already parses
  // (spec 2026-09-18-tag-clusters-design § 4).
  app.get('/api/sessions/count', () => {
    const row = db.select({ total: sql<number>`COUNT(*)` }).from(sessions).get() as {
      total: number;
    };
    return { total: row.total };
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
        .get();
      cursor = parent?.parent_id ?? null;
    }
    return { session: toApiSession(ctx, row), lineage };
  });

  /**
   * A session's transcript as messages, or `null` when the id itself is
   * unknown — the one case that is a 404.
   *
   * Two different "missing"s, and only one of them is a 404. A row that exists
   * with no file behind it is the ordinary state of a session Orbital has just
   * launched: the row goes in with `project_dir: ''` and the CLI writes the
   * transcript a moment later. A session with nothing written yet has an empty
   * transcript, not a missing one, so it comes back as no messages rather than
   * 404ing every launch.
   *
   * Reading from disk rather than from anything held in memory is what makes
   * this work for every session Orbital knows, including the terminal ones it
   * only ever watches.
   */
  function readTranscriptMessages(id: string): ChatMessage[] | null {
    const row = db
      .select({ project_dir: sessions.projectDir })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (!row) return null;
    try {
      const text = readFileSync(join(ctx.projectsDir, row.project_dir, `${id}.jsonl`), 'utf8');
      return entriesToMessages(parseTranscript(text), ctx.images);
    } catch {
      return [];
    }
  }

  app.get('/api/sessions/:id/messages', (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const messages = readTranscriptMessages(id);
    if (!messages) return reply.code(404).send({ error: 'not found' });
    const limit = Math.min(Number(q.limit ?? 100), 500);
    const before = q.before ? messages.findIndex((m) => m.id === q.before) : messages.length;
    const end = before === -1 ? messages.length : before;
    return { messages: messages.slice(Math.max(0, end - limit), end) };
  });

  // Transcript images, served straight from the content-addressed store.
  // The ref regex is the whole security story: 64 lowercase hex chars plus
  // a whitelisted extension can neither traverse nor name anything the
  // store did not write. The hash-as-name is also what makes `immutable`
  // honest — a ref's bytes can be pruned, never replaced.
  app.get('/api/images/:ref', (req, reply) => {
    const { ref } = req.params as { ref: string };
    const match = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.exec(ref);
    if (!match) return reply.code(404).send({ error: 'not found' });
    let bytes;
    try {
      bytes = readFileSync(join(ctx.imagesDir, ref));
    } catch {
      // Pruned from the cache — the web draws its NOT IN CACHE placeholder.
      return reply.code(404).send({ error: 'not found' });
    }
    reply.header('content-type', IMAGE_CONTENT_TYPES[match[1]]);
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(bytes);
  });

  // The file viewer's read (spec 2026-09-19-file-viewer-design). The session
  // row's cwd is the sandbox, and `readFilePreview` owns the whole security
  // story — realpath before any check, so neither `..` nor a symlink names
  // anything outside it. The path is taken verbatim: a `:line` suffix never
  // travels here, the client keeps it for scrolling.
  app.get('/api/files', (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!q.session || !q.path) return reply.code(400).send({ error: 'missing_params' });
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, q.session)).get() as
      | SessionRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const result = readFilePreview(row.cwd, q.path);
    switch (result.kind) {
      case 'ok':
        return {
          content: result.content, size: result.size,
          mtimeMs: result.mtimeMs, lines: result.lines,
        };
      case 'not_found':
        return reply.code(404).send({ error: 'not_found' });
      case 'outside':
        return reply.code(403).send({ error: 'outside_cwd' });
      case 'too_large':
        return reply.code(413).send({ error: 'too_large', size: result.size });
      case 'binary':
        return reply
          .code(415)
          .send({ error: 'binary', size: result.size, mediaType: result.mediaType });
    }
  });

  /**
   * The composer's `/` catalog (spec 2026-09-20-composer-design § Server).
   *
   * Two sources, and which one is the truth depends on whether anything is
   * listening: with a live SDK query the CLI's own list is definitive — it is
   * the only thing that knows about built-ins — and the filesystem scan is
   * demoted to attributing a `source` badge by name. Without one (an ended
   * session, or the New Session dialog, which has only a cwd) the scan is the
   * whole answer, built-ins deliberately absent: offering a command the CLI may
   * not honour is worse than omitting it.
   */
  app.get('/api/commands', async (req, reply) => {
    const q = req.query as Record<string, string>;
    let cwd: string;
    let sessionId: string | null = null;
    if (q.session) {
      const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, q.session)).get() as
        | SessionRow
        | undefined;
      if (!row) return reply.code(404).send({ error: 'not_found' });
      cwd = row.cwd;
      sessionId = q.session;
    } else if (q.cwd) {
      // The one door an unexpanded path comes through here, same as
      // `POST /api/sessions`: the dialog's directory field is hand-typed.
      cwd = expandHome(q.cwd);
    } else {
      return reply.code(400).send({ error: 'missing_params' });
    }

    const scanned = collectCommands({ claudeDir: ctx.claudeDir, cwd });
    const live = sessionId ? await ctx.runner.commands(sessionId) : null;
    if (!live) return { commands: scanned };
    const byName = new Map(scanned.map((c) => [c.name, c]));
    const commands = live
      .map((c) => {
        const match = byName.get(c.name);
        return {
          name: c.name,
          // The CLI answers `''` for plenty of commands it knows only by name;
          // the file it came from usually says more.
          description: c.description || match?.description || '',
          source: match?.source ?? 'built-in',
          ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
          ...(c.aliases ? { aliases: c.aliases } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { commands };
  });

  /**
   * The composer's `@` completion. Confined to the session's cwd by the same
   * helper the file viewer uses, and deliberately incapable of an error:
   * a popup fed by keystrokes asks about half-typed paths constantly, and
   * `{ entries: [] }` is the right answer to every one that names nothing.
   */
  app.get('/api/files/complete', (req, reply) => {
    const q = req.query as Record<string, string>;
    let cwd: string;
    if (q.session) {
      const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, q.session)).get() as
        | SessionRow
        | undefined;
      if (!row) return reply.code(404).send({ error: 'not_found' });
      cwd = row.cwd;
    } else if (q.cwd) {
      cwd = expandHome(q.cwd);
    } else {
      return reply.code(400).send({ error: 'missing_params' });
    }
    return { entries: completeFilePath(cwd, q.prefix ?? '') };
  });

  /**
   * One composer attachment, multipart, one file per request — the body of both
   * attachment routes.
   *
   * The bytes go straight into the content-addressed image store, so the
   * response is an `ImageRefEntry` and nothing on Orbital's own wire ever
   * carries base64 — the send path reads the ref back out again for the single
   * hop into the SDK. The whitelist is the store's own (it is what decides
   * which extension a ref can wear), so a refusal is `putBytes` saying no
   * rather than a second list here that could drift from it.
   */
  async function storeAttachment(req: FastifyRequest, reply: FastifyReply) {
    // Read past the ceiling but not without limit: the 413 names the size it
    // measured, which takes reading the whole file, and a wall at twice the
    // ceiling keeps that from being unbounded memory. `truncated` says so when
    // even the wall was hit, so the size in the body is never read as exact.
    const part = await req.file({
      limits: { fileSize: ATTACHMENT_MAX_BYTES * 2 },
      throwFileSizeLimit: false,
    });
    if (!part) return reply.code(400).send({ error: 'missing_file' });
    const bytes = await part.toBuffer();
    if (part.file.truncated || bytes.length > ATTACHMENT_MAX_BYTES) {
      return reply.code(413).send({
        error: 'too_large',
        size: bytes.length,
        ...(part.file.truncated ? { truncated: true } : {}),
      });
    }
    if (bytes.length === 0) return reply.code(400).send({ error: 'empty_file' });
    const entry = ctx.images.putBytes(part.mimetype, bytes);
    if (!entry) return reply.code(415).send({ error: 'not_image', mediaType: part.mimetype });
    return reply.code(201).send(entry);
  }

  /**
   * The same upload, before any session exists — what the New Session dialog
   * attaches through, since its session is not created until Launch and the
   * refs have to travel in that very request.
   *
   * It is the scoped route minus the session lookup, and the lookup is all it
   * is minus: the image store is content-addressed and GLOBAL — one directory,
   * keyed by the bytes' own sha, shared by every session — so a session id
   * neither scopes the write nor authorises it. The 404 on the route below
   * rejects nothing a caller could not simply post here instead; it is a
   * courtesy to a client that named a session that has gone away, not a guard.
   * What actually gates this port is the API token
   * ([[api-token-guards-the-local-port]]), the same umbrella that covers
   * `?cwd=` on `/api/commands` and `/api/files/complete`.
   */
  app.post('/api/attachments', storeAttachment);

  app.post('/api/sessions/:id/attachments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return storeAttachment(req, reply);
  });

  app.post('/api/sessions', async (req, reply) => {
    const body = req.body as {
      cwd: string; prompt: string; permissionMode: PermissionMode;
      tagId?: number; model?: string; resume?: string; parentId?: string;
      sessionId?: string; attachments?: string[];
    };
    if (invalidAttachments(body.attachments)) {
      return reply.code(400).send({ error: 'invalid_attachment' });
    }
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
        // The row is born already claimed. `start()` above announced the
        // claim to a row that did not exist yet, so without this a session
        // killed during its very first turn would look to the next boot like
        // one the Runner never owned — the exact window a save-triggered
        // restart lands in (spec 2026-09-21-session-autoheal-design). Read
        // now rather than remembered from `start()`, so a turn that has
        // already finished writes `needs_input` and not a stale `working`.
        runnerStatus: ctx.runner.status(sessionId) ?? null,
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

  /**
   * Map-only dismissal — the hole's absorption (spec
   * 2026-09-18-tag-clusters-design § 5). `dismissed: true` stamps the
   * session, `false` is the 10s undo. The map is the only reader; the
   * sidebar, search and every list endpoint ignore the stamp.
   *
   * Dismissing also clears any pin: the manual gesture wins, so dragging a
   * pinned planet into the hole absorbs it and unpins it in one move (spec
   * 2026-09-20-pinned-sessions-design § Server).
   */
  app.put('/api/sessions/:id/dismissed', (req, reply) => {
    const { id } = req.params as { id: string };
    const { dismissed } = (req.body ?? {}) as { dismissed?: unknown };
    if (typeof dismissed !== 'boolean') {
      return reply.code(400).send({ error: 'dismissed must be a boolean' });
    }
    const result = db
      .update(sessions)
      .set(
        dismissed
          ? { mapDismissedAt: Date.now(), pinnedAt: null }
          : { mapDismissedAt: null },
      )
      .where(eq(sessions.id, id))
      .run();
    if (result.changes === 0) return reply.code(404).send({ error: 'not found' });
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
    ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, row) });
    return { ok: true };
  });

  /**
   * The pin — a per-session, manual exemption from the map's release timer
   * (spec 2026-09-20-pinned-sessions-design). `pinned: true` stamps the row
   * with now, `false` clears it; the timer itself is applied client-side, so
   * the server's whole job is the stamp and the ordering it feeds.
   *
   * Pinning also clears the dismissal, which is what pulls an already
   * absorbed session back onto the map. The two stamps never coexist.
   */
  app.put('/api/sessions/:id/pinned', (req, reply) => {
    const { id } = req.params as { id: string };
    const { pinned } = (req.body ?? {}) as { pinned?: unknown };
    if (typeof pinned !== 'boolean') {
      return reply.code(400).send({ error: 'pinned must be a boolean' });
    }
    const result = db
      .update(sessions)
      .set(pinned ? { pinnedAt: Date.now(), mapDismissedAt: null } : { pinnedAt: null })
      .where(eq(sessions.id, id))
      .run();
    if (result.changes === 0) return reply.code(404).send({ error: 'not found' });
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
    ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, row) });
    return { ok: true };
  });

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text, attachments } = req.body as { text: string; attachments?: string[] };
    if (invalidAttachments(attachments)) {
      return reply.code(400).send({ error: 'invalid_attachment' });
    }
    // New activity brings a session back to the map, whichever path below
    // delivers the message — a dismissed session someone is typing into is
    // evidently not history any more.
    db.update(sessions).set({ mapDismissedAt: null }).where(eq(sessions.id, id)).run();
    try {
      ctx.runner.send(id, text, attachments);
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
        // The revive is the same turn the send would have been, images included.
        attachments,
      });
      // The session is Orbital's now. Left `terminal`, the row reads as
      // {source: terminal, status: live} — the exact shape `isReadOnly`
      // locks the composer on (fix: reviving-a-terminal-session-leaves-it-read-only).
      db.update(sessions).set({ source: 'web' }).where(eq(sessions.id, id)).run();
      const revivedRow = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
      ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, revivedRow) });
      return { ok: true, revived: true };
    }
  });

  /**
   * The answer to a parked question (spec
   * 2026-09-20-interactive-decisions-design § Channel). REST rather than the
   * hub because answering has a real outcome the client has to hear: the
   * decision may already be gone — answered in another window, interrupted, or
   * ended — and that is this 404.
   *
   * `answers` is complete or it is nothing: one entry per question, keyed by
   * the question's own text, which is the shape the SDK takes it in. What each
   * answer *says* is the client's business; only its presence is checked here.
   */
  app.post('/api/sessions/:id/decision/:decisionId', (req, reply) => {
    const { id, decisionId } = req.params as { id: string; decisionId: string };
    const { answers } = (req.body ?? {}) as { answers?: unknown };
    if (
      !answers ||
      typeof answers !== 'object' ||
      Array.isArray(answers) ||
      Object.values(answers).some((a) => typeof a !== 'string')
    ) {
      return reply.code(400).send({ error: 'answers must be an object of strings' });
    }
    const pending = ctx.runner.pendingDecision(id);
    if (!pending || pending.id !== decisionId) return reply.code(404).send({ error: 'not found' });
    const given = answers as Record<string, string>;
    if (decisionQuestions(pending.input).some((q) => typeof given[q] !== 'string')) {
      return reply.code(400).send({ error: 'answers is missing a question' });
    }
    // Re-read rather than trusting the lookup above: the decision may have
    // settled between the two, which is the same 404 as never having existed.
    if (!ctx.runner.answerDecision(id, decisionId, given)) {
      return reply.code(404).send({ error: 'not found' });
    }
    return { ok: true };
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
    // A title someone typed is a decision, not a guess: `manual` is what stops
    // the titler from ever renaming this session again.
    const result = db
      .update(sessions)
      .set({ title, titleSource: 'manual' })
      .where(eq(sessions.id, id))
      .run();
    if (result.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  /**
   * Name this session from its contents, now — the ⟳ beside the title.
   *
   * The counterpart to the automatic path in `SessionTitler`, and deliberately
   * free of every guard that one weighs: the `auto_title_sessions` setting
   * governs whether Orbital renames sessions on its own, not whether it
   * answers a click, and a `manual` title is exactly what someone reaching for
   * this button is trying to be rid of.
   *
   * Works for a terminal session too. The content comes off disk, so the
   * Runner's in-memory buffer — which only web sessions ever fill, and only
   * while they are alive — is not involved.
   */
  app.post('/api/sessions/:id/retitle', async (req, reply) => {
    const { id } = req.params as { id: string };
    const messages = readTranscriptMessages(id);
    if (!messages) return reply.code(404).send({ error: 'not found' });
    // Nothing to read is not a failure, and it is not something to ask a model
    // about either: a session mid-launch has no transcript yet.
    if (messages.length === 0) {
      return reply.code(409).send({ error: 'this session has not written anything yet' });
    }
    try {
      return await ctx.titler.retitleNow(id, messages);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.errors.record({
        source: 'server',
        kind: 'api_request',
        sessionId: id,
        message,
        detail: err instanceof Error ? (err.stack ?? null) : null,
        context: { while: 'regenerating a session title' },
      });
      return reply.code(502).send({ error: message });
    }
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
  app.patch('/api/tags/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      name?: string; hue?: number;
      // The clump's stored home spot (tag clusters). Explicit null clears it
      // back to the automatic layout, so `undefined` and `null` differ here.
      anchor_x?: number | null; anchor_y?: number | null;
    };
    const set: Partial<{ name: string; hue: number; anchorX: number | null; anchorY: number | null }> = {};
    if (body.name != null) set.name = body.name;
    if (body.hue != null) set.hue = body.hue;
    for (const [key, column] of [['anchor_x', 'anchorX'], ['anchor_y', 'anchorY']] as const) {
      if (!(key in body)) continue;
      const value = body[key];
      if (value !== null && !Number.isFinite(value)) {
        return reply.code(400).send({ error: `${key} must be a finite number or null` });
      }
      set[column] = value;
    }
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

  app.get('/api/models', async () => ({
    models: await ctx.models.list(),
    contextWindows: ctx.models.learnedContextWindows(),
  }));

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
      // Same reasoning as the idle timeout above, with more at stake: the
      // dialog confirms "this will drop N sessions" before saving, so the
      // sweep has to happen now. Deferring it to the next boot would make
      // that confirmation a promise about some later restart.
      if (k === RETENTION_KEY) ctx.retention.sweep();
    }
    return { ok: true };
  });

  /**
   * What a retention policy would remove, without removing it. This is what
   * the confirmation names, so it runs the sweep's own predicate rather than
   * a second copy of it — a count that disagreed with the delete would be
   * worse than no count.
   */
  app.get('/api/sessions/retention-preview', (req) => {
    const { days } = req.query as { days?: string };
    return { count: ctx.retention.preview(String(days ?? '')) };
  });
}
