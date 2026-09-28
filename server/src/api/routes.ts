import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, entriesToMessages } from '../transcript/parser.js';
import { regenerateRuleTags, matchRule } from '../tags/rules.js';
import { expandHome } from '../paths.js';
import { readFilePreview } from '../files/preview.js';
import { completeFilePath } from '../files/complete.js';
import { OpenTabsReader } from '../files/openTabs.js';
import { collectCommands } from '../commands/catalog.js';
import type { OrbitalDb } from '../db/database.js';
import {
  compactionFailures,
  sessionColumns,
  sessions,
  sessionTags,
  settings as settingsTable,
  tagColumns,
  tagRuleColumns,
  tagRules,
  tags,
} from '../db/schema.js';
import {
  decisionQuestions,
  type DecisionAnswer,
  type Runner,
  type SimulatedCompactionOutcome,
} from '../runner/runner.js';
import { mergeCompactionFailures, type CompactionFailureRecord } from '../transcript/compaction.js';
import { RETENTION_KEY } from '../retention.js';
import type { SessionRegistry } from '../watcher/registry.js';
import type { Hub } from './hub.js';
import { toApiSession } from './shape.js';
import type { GitStore } from '../git/store.js';
import type { IdeStore } from '../ide/store.js';
import type { SubagentStore, SubagentTranscripts } from '../transcript/subagents.js';
import type { ChatMessage, ErrorKind, PermissionMode, SessionRow, TagRule } from '../types.js';
import type { ModelCatalog } from '../models/catalog.js';
import type { ErrorLog } from '../errors/log.js';
import type { ImageStore } from '../images/store.js';
import type { SessionTitler } from '../titler/titler.js';
import { registerStatsRoutes } from './stats.js';
import { buildWalkthrough } from '../walkthrough/spine.js';
import { readSubagentMessages, subagentDirOf } from '../walkthrough/subagents.js';
import { StampedCache, dirStamp, fileStamp } from '../transcript/stampedCache.js';
import { buildAskText, buildNarrateText } from '../walkthrough/tag.js';
import type { Step, StepCall, Walkthrough } from '../walkthrough/types.js';

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
  /** Git readings per working tree, cached and watched (spec
   * 2026-09-22-git-location-indicator-design). Read through `toApiSession`. */
  git: GitStore;
  /** The editors open on this machine, per workspace (spec
   * 2026-09-23-ide-bridge-design). Read through `toApiSession`, and directly
   * by the open-files route. */
  ide: IdeStore;
  /** Every subagent's own transcript, keyed the same way `subagents` is — see
   * `SubagentTranscripts` (spec `2026-09-22-subagent-transcript-panel-design.md`
   * § 3). The panel's one read model. */
  subagentTranscripts: SubagentTranscripts;
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
  /**
   * Whether the dev-only routes are registered — the compaction simulation
   * (spec 2026-09-28-context-compaction-design § Dev simulation). Off unless
   * the server runs from `npm run dev`; never on in the packaged app.
   */
  devTools?: boolean;
}

const SIMULATED_OUTCOMES = new Set<string>(['success', 'success_no_post_tokens', 'failed', 'failed_no_error']);

/** The longest compaction the simulation will play, in seconds. */
const SIMULATION_MAX_SECONDS = 600;

/**
 * Dev-only: plays a compaction on a running session through the Runner's own
 * message handler, so the UI can be exercised without a real failure. It sends
 * nothing to the CLI.
 */
function registerDevRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/api/dev/sessions/:id/simulate-compaction', (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { outcome?: unknown; seconds?: unknown };
    const outcome = body.outcome ?? 'success';
    if (typeof outcome !== 'string' || !SIMULATED_OUTCOMES.has(outcome)) {
      return reply.code(400).send({ error: `outcome must be one of ${[...SIMULATED_OUTCOMES].join(', ')}` });
    }
    const seconds = body.seconds === undefined ? 5 : Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > SIMULATION_MAX_SECONDS) {
      return reply.code(400).send({ error: `seconds must be between 0 and ${SIMULATION_MAX_SECONDS}` });
    }
    if (!ctx.runner.simulateCompaction(id, outcome as SimulatedCompactionOutcome, seconds)) {
      return reply.code(409).send({ error: 'session is not running in this server' });
    }
    return reply.code(202).send({ ok: true, outcome, seconds });
  });
}

/** The only kinds `POST /api/errors` will accept, mirroring `ErrorKind`. */
const ERROR_KINDS = new Set<string>([
  'session_failed',
  'api_request',
  'render_crash',
  'transcript_gap',
]);

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
 * Longest id `POST /api/models/validate` will spawn a CLI for. Real ids are
 * a few dozen characters; the cap only keeps arbitrary text off the CLI's
 * command line.
 */
const MODEL_ID_MAX_LENGTH = 100;

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
 * How many sessions' parsed transcripts (and, separately, walkthroughs) the
 * server keeps. A count rather than bytes, and a small one: the parsed form
 * of the largest transcripts runs to hundreds of megabytes of heap, and what
 * the cache is for is the session being paged through right now.
 */
export const TRANSCRIPT_CACHE_SESSIONS = 3;

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
  if (ctx.devTools) registerDevRoutes(app, ctx);
  /**
   * One reader for the whole server, because its whole job is to hold a tab
   * list still for a moment across the burst of requests one `@` produces
   * (spec 2026-09-23-ide-bridge-design § Open files, for `@` completion).
   */
  const openTabs = new OpenTabsReader(ctx.ide);
  /** Parsed transcripts by path, so paging back does not re-parse per page. */
  const transcriptMessages = new StampedCache<ChatMessage[]>(TRANSCRIPT_CACHE_SESSIONS);
  /** Walkthroughs by transcript path; selecting a session asks for one. */
  const walkthroughs = new StampedCache<Walkthrough>(TRANSCRIPT_CACHE_SESSIONS);

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

  // The trash's label needs the whole index's size, and `GET /api/sessions`
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
    return { session: toApiSession(ctx, row) };
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
    const path = join(ctx.projectsDir, row.project_dir, `${id}.jsonl`);
    const stamp = fileStamp(path);
    // Cached as finished wire messages rather than raw entries, so a page
    // also skips `entriesToMessages` and the image decoding inside it.
    const fromFile =
      stamp === null
        ? []
        : transcriptMessages.get(path, stamp, () => {
            try {
              return entriesToMessages(parseTranscript(readFileSync(path, 'utf8')), ctx.images);
            } catch {
              return [];
            }
          });
    // Failed compactions live in the database, not the file, so they are
    // merged in at their timestamp on every read rather than cached with it
    // (spec 2026-09-28-context-compaction-design § Failure).
    const failures = db
      .select()
      .from(compactionFailures)
      .where(eq(compactionFailures.sessionId, id))
      .all() as CompactionFailureRecord[];
    return failures.length ? mergeCompactionFailures(fromFile, failures) : fromFile;
  }

  app.get('/api/sessions/:id/messages', (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const messages = readTranscriptMessages(id);
    if (!messages) return reply.code(404).send({ error: 'not found' });
    const limit = Math.min(Number(q.limit ?? 100), 500);
    // A `before` cursor this transcript does not contain is answered with an
    // empty page, never with the tail. The cursor is whatever the client holds
    // oldest, and for a session Orbital launched that is a message the file
    // never had: a live row (`<session>:<seq>:<i>`, see `sdkToChatMessages`)
    // or the optimistic `local:` first prompt. Everything the client holds
    // there arrived live from the launch on, so nothing is older than it.
    // Answering with the tail instead handed back the whole transcript under
    // file ids the client's dedupe cannot match, and "load older" printed the
    // session a second time above itself.
    const end = q.before ? messages.findIndex((m) => m.id === q.before) : messages.length;
    if (end === -1) return { messages: [] };
    return { messages: messages.slice(Math.max(0, end - limit), end) };
  });

  /**
   * A subagent's own transcript — the panel's read (spec
   * `2026-09-22-subagent-transcript-panel-design.md` § 9). Keyed by
   * `toolUseId`, not `SubagentInfo.id`: that is the same key
   * `SubagentTranscripts` buffers under (see its class comment), and the
   * only key an `Agent` tool_use in the parent transcript could ever join
   * back to. An agent whose `toolUseId` is absent — `feed()`'s
   * transcript-only path never learns one — can never be named by this
   * route, which is fine: such an agent has no live buffer to show anyway.
   *
   * Three answers, not two, and the middle one is the one worth getting
   * wrong:
   *
   * 1. `toolUseId` names no agent `SubagentStore` knows for this session →
   *    404, STREAM LOST. This is the server-restarted case: `SubagentStore`
   *    and `SubagentTranscripts` are both in-memory and die together, so a
   *    session that used to have this agent but no longer does really has
   *    lost the stream. An ENDED agent is not that case — `all()` keeps it
   *    precisely so this check keeps answering "known" once its moon has
   *    left the map (subagent list spec § 5).
   * 2. The agent IS known but has never been appended to — it started and
   *    has not produced a message yet — → 200, `{ messages: [],
   *    droppedCount: 0 }`. This is deliberately NOT the same as case 1: a
   *    buffer is created lazily, on first append (see
   *    `SubagentTranscripts.append`), so "no buffer yet" is the ordinary
   *    state of a panel opened moments after the agent launched, and
   *    404-ing it would tell an honest, running agent's panel that its
   *    transcript was lost.
   * 3. The agent is known and has a buffer → 200 with its messages and
   *    `droppedCount`.
   */
  app.get('/api/sessions/:id/subagents/:toolUseId/messages', (req, reply) => {
    const { id, toolUseId } = req.params as { id: string; toolUseId: string };
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not found' });
    const known = ctx.subagents.all(id).some((a) => a.toolUseId === toolUseId);
    if (!known) return reply.code(404).send({ error: 'not found' });
    const transcript = ctx.subagentTranscripts.get(id, toolUseId);
    if (!transcript) return { messages: [], droppedCount: 0 };
    return { messages: transcript.messages, droppedCount: transcript.droppedCount };
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
   *
   * The editor's open tabs are ranked above the walk of the working tree when
   * there is an editor on this directory, and the answer is unchanged when
   * there is not (spec 2026-09-23-ide-bridge-design § Open files).
   */
  app.get('/api/files/complete', async (req, reply) => {
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
    return { entries: completeFilePath(cwd, q.prefix ?? '', await openTabs.read(cwd)) };
  });

  /**
   * The tabs open in the editor covering this session's workspace, in the
   * editor's own order (spec 2026-09-23-ide-bridge-design § Open files).
   *
   * Pulled on demand rather than pushed on the session shape: there can be
   * dozens, they change constantly, and only the `@` popup wants them.
   *
   * `404` is the answer to every kind of "no editor" there is — no lock, a
   * lock covering another project, a connection that never came up, an
   * extension without the tool. The caller has one thing to handle, and it is
   * the thing Orbital did before this feature existed.
   */
  app.get('/api/sessions/:id/ide/open-files', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db
      .select({ cwd: sessions.cwd })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const files = await ctx.ide.openFiles(row.cwd);
    if (!files) return reply.code(404).send({ error: 'no_ide' });
    return { files };
  });

  /**
   * Reveals a path in the editor covering this session's workspace
   * (spec 2026-09-23-ide-bridge-design § Talking back to the editor).
   *
   * The same `404`-for-every-no as the open-files route, and for the same
   * reason: the caller has one thing to handle. A path outside the session's
   * `cwd` is among them — Orbital refuses to read one for a session, so it
   * does not ask an editor to open one on that session's behalf either.
   *
   * `204`, not the file: nothing came back and nothing is shown. The receipt
   * the browser draws is the request having succeeded.
   */
  app.post('/api/sessions/:id/ide/open-file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { path?: unknown; line?: unknown };
    if (typeof body.path !== 'string' || body.path === '') {
      return reply.code(400).send({ error: 'missing_path' });
    }
    const line =
      typeof body.line === 'number' && Number.isSafeInteger(body.line) && body.line > 0
        ? body.line
        : null;
    const row = db
      .select({ cwd: sessions.cwd })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const opened = await ctx.ide.openFile(row.cwd, expandHome(body.path), line);
    if (!opened) return reply.code(404).send({ error: 'no_ide' });
    return reply.code(204).send();
  });

  /**
   * The editor's own findings for this session's workspace — everything it
   * knows, or one file's worth when `path` names one
   * (spec § Talking back to the editor).
   *
   * What makes this worth a route at all: the editor's inspections are
   * things no test run reports, so they answer "did that edit break
   * anything" without a build. The same `404` covers every kind of no
   * editor.
   */
  app.get('/api/sessions/:id/ide/diagnostics', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string };
    const row = db
      .select({ cwd: sessions.cwd })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const diagnostics = await ctx.ide.diagnostics(
      row.cwd,
      q.path ? expandHome(q.path) : undefined,
    );
    if (!diagnostics) return reply.code(404).send({ error: 'no_ide' });
    return { diagnostics };
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
      tagId?: number; model?: string; resume?: string;
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
      // alone would miss every session from a previous boot. `hasRun()` also
      // answers for sessions whose process has stopped, which is the answer
      // we want: their transcript still sits on disk under that name.
      const rowExists = db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, clientId))
        .get() !== undefined;
      if (rowExists || ctx.runner.hasRun(clientId)) {
        return reply.code(409).send({ error: 'session id is already taken' });
      }
    }
    const sessionId = await ctx.runner.start({ ...body, cwd, sessionId: clientId });
    db.insert(sessions)
      .values({
        id: sessionId, projectDir: '', cwd, source: 'web',
        permissionMode: body.permissionMode, model: body.model ?? null,
        lastAt: Date.now(),
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
   * The pin — a per-session, manual "keep this on the map", which holds even
   * once the session has ended (spec 2026-09-20-pinned-sessions-design, spec
   * 2026-09-24-sessions-end-only-by-hand-design § 3). `pinned: true` stamps
   * the row with now, `false` clears it; the map applies it client-side, so
   * the server's whole job is the stamp and the ordering it feeds.
   */
  app.put('/api/sessions/:id/pinned', (req, reply) => {
    const { id } = req.params as { id: string };
    const { pinned } = (req.body ?? {}) as { pinned?: unknown };
    if (typeof pinned !== 'boolean') {
      return reply.code(400).send({ error: 'pinned must be a boolean' });
    }
    const result = db
      .update(sessions)
      .set({ pinnedAt: pinned ? Date.now() : null })
      .where(eq(sessions.id, id))
      .run();
    if (result.changes === 0) return reply.code(404).send({ error: 'not found' });
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
    ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, row) });
    return { ok: true };
  });

  /**
   * One delivery path for anything Orbital says INTO a session: the composer's
   * text, and the walkthrough's narrate and ask turns. Sends if the runner
   * holds the session; otherwise revives it by resuming — unless a terminal
   * owns it, which cannot be taken over.
   */
  async function deliverToSession(
    id: string, text: string, attachments?: string[],
  ): Promise<'sent' | 'revived' | 'not_found' | 'terminal'> {
    // Writing to an ended session reopens it, whichever path below delivers
    // the message — a session someone is typing into is evidently not over
    // (spec 2026-09-24-sessions-end-only-by-hand-design § 1). Only once it
    // was delivered, though: a revive that throws leaves the session ended.
    const reopen = () => db.update(sessions).set({ endedAt: null }).where(eq(sessions.id, id)).run();
    try {
      ctx.runner.send(id, text, attachments);
      reopen();
      return 'sent';
    } catch {
      // Inactive in the runner — revive by resuming, unless it's live in a
      // terminal (which owns the SDK process and can't be taken over).
      const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as
        | SessionRow
        | undefined;
      if (!row) return 'not_found';
      if (ctx.registry.get(id)) return 'terminal';
      const permissionMode = (row.permission_mode ??
        ctx.settings.get('default_permission_mode')) as PermissionMode;
      // Reopened ahead of the start, not after it: the Runner announces the
      // revived session as it starts, and it reads the row for that.
      reopen();
      try {
        await ctx.runner.start({
          cwd: row.cwd, prompt: text, permissionMode, resume: id,
          // Without this, reviving silently moved the session onto the CLI's
          // default model.
          model: row.model ?? undefined,
          // The revive is the same turn the send would have been, images included.
          attachments,
        });
      } catch (err) {
        db.update(sessions).set({ endedAt: row.ended_at }).where(eq(sessions.id, id)).run();
        throw err;
      }
      // The session is Orbital's now. Left `terminal`, the row reads as
      // {source: terminal, status: live} — the exact shape `isReadOnly`
      // locks the composer on (fix: reviving-a-terminal-session-leaves-it-read-only).
      //
      // And the revive is a turn starting, which retires the interrupted
      // mark. The Runner cannot say so here: a started session is born
      // `working`, so no status transition fires for the turn it opens with.
      db.update(sessions).set({ source: 'web', interruptedAt: null }).where(eq(sessions.id, id)).run();
      const revivedRow = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
      ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, revivedRow) });
      return 'revived';
    }
  }

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text, attachments } = req.body as { text: string; attachments?: string[] };
    if (invalidAttachments(attachments)) {
      return reply.code(400).send({ error: 'invalid_attachment' });
    }
    const outcome = await deliverToSession(id, text, attachments);
    if (outcome === 'not_found') return reply.code(404).send({ error: 'not found' });
    if (outcome === 'terminal') return reply.code(409).send({ error: 'session is live in a terminal' });
    return outcome === 'revived' ? { ok: true, revived: true } : { ok: true };
  });

  // ---- Walkthrough (spec: 2026-09-23-walkthrough-design) ----------------

  function walkthroughFor(id: string): { row: SessionRow; walkthrough: Walkthrough } | null {
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow | undefined;
    if (!row) return null;
    const transcriptPath = join(ctx.projectsDir, row.project_dir, `${id}.jsonl`);
    // The subagents' files feed the walkthrough too, so they are part of the
    // stamp: an agent that writes on changes it while the parent file sits
    // still.
    const stamp = `${fileStamp(transcriptPath) ?? '-'}#${dirStamp(subagentDirOf(transcriptPath))}`;
    const walkthrough = walkthroughs.get(transcriptPath, stamp, () =>
      buildWalkthrough(readTranscriptMessages(id) ?? [], readSubagentMessages(transcriptPath, ctx.images)),
    );
    return { row, walkthrough };
  }

  /** A step's writing calls, a subagent step's sub-steps included. */
  function stepCalls(step: Step): StepCall[] {
    return step.subagent ? step.subagent.steps.flatMap(stepCalls) : step.calls;
  }
  function stepPaths(step: Step): string[] {
    return stepCalls(step)
      .map((c) => {
        const input = c.call.toolInput as Record<string, unknown> | null;
        const p = input?.file_path ?? input?.notebook_path;
        return typeof p === 'string' ? p : null;
      })
      .filter((p): p is string => p !== null);
  }

  app.get('/api/sessions/:id/walkthrough', (req, reply) => {
    const { id } = req.params as { id: string };
    const found = walkthroughFor(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    return { session: toApiSession(ctx, found.row), walkthrough: found.walkthrough };
  });

  /** The header's entry control asks this; it is the same parse, smaller answer. */
  app.get('/api/sessions/:id/walkthrough/summary', (req, reply) => {
    const { id } = req.params as { id: string };
    const found = walkthroughFor(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    const w = found.walkthrough;
    return {
      steps: w.steps.length,
      files: w.files.length,
      blindAlleys: w.steps.filter((s) => s.fate.some((f) => f.kind === 'reverted')).length,
      subagents: w.steps.filter((s) => s.subagent !== null).length,
    };
  });

  /**
   * Both turn-sending routes refuse the same two things: a session Orbital did
   * not run (a terminal owns it, or the row says so), and a session mid-turn —
   * a question injected into a running turn is not the question it appears to
   * be (spec § Asking). Mid-turn is working, or parked on a decision; the
   * runner's `needs_input` alone is every live session between turns, which
   * is exactly when a walkthrough is opened, so it does not refuse.
   */
  function refuseTurn(row: SessionRow, id: string): { code: number; error: string } | null {
    if (row.source === 'terminal' || ctx.registry.get(id)) return { code: 409, error: 'terminal_session' };
    if (ctx.runner.status(id) === 'working' || ctx.runner.pendingDecision(id) !== null) {
      return { code: 409, error: 'busy' };
    }
    return null;
  }

  async function sendTurn(id: string, text: string, reply: FastifyReply) {
    const outcome = await deliverToSession(id, text);
    if (outcome === 'not_found') return reply.code(404).send({ error: 'not found' });
    if (outcome === 'terminal') return reply.code(409).send({ error: 'terminal_session' });
    return outcome === 'revived' ? { ok: true, revived: true } : { ok: true };
  }

  app.post('/api/sessions/:id/walkthrough/narrate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = walkthroughFor(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    const refused = refuseTurn(found.row, id);
    if (refused) return reply.code(refused.code).send({ error: refused.error });
    if (found.walkthrough.steps.length === 0) return reply.code(400).send({ error: 'no_steps' });
    const text = buildNarrateText(found.walkthrough.steps.map((s) => ({
      id: s.id, ordinal: s.ordinal,
      paths: [...new Set(stepPaths(s))],
      firstLine: s.narration.split('\n')[0] ?? '',
    })));
    return sendTurn(id, text, reply);
  });

  app.post('/api/sessions/:id/walkthrough/ask', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { step?: unknown; question?: unknown };
    if (typeof body.question !== 'string' || !body.question.trim()) {
      return reply.code(400).send({ error: 'missing_question' });
    }
    const found = walkthroughFor(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    const step = found.walkthrough.steps.find((s) => s.id === body.step);
    if (!step) return reply.code(400).send({ error: 'unknown_step' });
    const refused = refuseTurn(found.row, id);
    if (refused) return reply.code(refused.code).send({ error: refused.error });
    const text = buildAskText(body.question, {
      step: step.id, ordinal: step.ordinal, paths: [...new Set(stepPaths(step))],
      calls: stepCalls(step).map((c) => ({ tool: c.call.toolName ?? '', input: c.call.toolInput })),
    });
    return sendTurn(id, text, reply);
  });

  /**
   * The answer to a parked decision (specs
   * 2026-09-20-interactive-decisions-design § Channel and
   * 2026-09-23-permission-and-plan-decisions-design § Channel). REST rather
   * than the hub because answering has a real outcome the client has to hear:
   * the decision may already be gone — answered in another window,
   * interrupted, or ended — and that is this 404.
   *
   * ONE endpoint for all three kinds, with the body read against the kind the
   * server is actually parked on rather than against whatever the client
   * thinks it is looking at. A client one version behind cannot approve a
   * permission prompt by posting question answers at it, and cannot corrupt a
   * tool's input by posting a verdict at a question.
   *
   * - `question` takes `{answers}`, complete or nothing: one entry per
   *   question, keyed by the question's own text, which is the shape the SDK
   *   takes it in. What each answer *says* is the client's business; only its
   *   presence is checked here.
   * - `permission` and `plan` take `{approved, message?}`. `message` is what
   *   the model reads back from a refusal.
   */
  app.post('/api/sessions/:id/decision/:decisionId', (req, reply) => {
    const { id, decisionId } = req.params as { id: string; decisionId: string };
    // The lookup comes first now: which body is valid depends on the kind, so
    // there is nothing to check a payload against until the decision is known.
    // A session with nothing parked is still the same 404 it always was.
    const pending = ctx.runner.pendingDecision(id);
    if (!pending || pending.id !== decisionId) return reply.code(404).send({ error: 'not found' });
    const body = (req.body ?? {}) as { answers?: unknown; approved?: unknown; message?: unknown };

    let answer: DecisionAnswer;
    if (pending.kind === 'question') {
      const { answers } = body;
      if (
        !answers ||
        typeof answers !== 'object' ||
        Array.isArray(answers) ||
        Object.values(answers).some((a) => typeof a !== 'string')
      ) {
        return reply.code(400).send({ error: 'answers must be an object of strings' });
      }
      const given = answers as Record<string, string>;
      if (decisionQuestions(pending.input).some((q) => typeof given[q] !== 'string')) {
        return reply.code(400).send({ error: 'answers is missing a question' });
      }
      answer = given;
    } else {
      if (typeof body.approved !== 'boolean') {
        return reply.code(400).send({ error: 'approved must be a boolean' });
      }
      if (body.message !== undefined && typeof body.message !== 'string') {
        return reply.code(400).send({ error: 'message must be a string' });
      }
      answer = {
        approved: body.approved,
        ...(typeof body.message === 'string' ? { message: body.message } : {}),
      };
    }

    // Re-read rather than trusting the lookup above: the decision may have
    // settled between the two, which is the same 404 as never having existed.
    if (!ctx.runner.answerDecision(id, decisionId, answer)) {
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
    if (ctx.runner.status(id)) {
      await ctx.runner.setModel(id, model);
    }
    // An ended session keeps the choice too: it is what the revive resumes on.
    db.update(sessions).set({ model }).where(eq(sessions.id, id)).run();
    const updated = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
    ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, updated) });
    return { ok: true };
  });

  /**
   * Writes the user's "this session is over" stamp — `now` to end, null to
   * reopen — and republishes the row, since `statusOf` reads it for every
   * Orbital session the Runner holds no process for (spec
   * 2026-09-24-sessions-end-only-by-hand-design § 1). The Runner only stops
   * processes; ending is this stamp, which is why the routes write it.
   */
  function stampEnded(id: string, endedAt: number | null): void {
    db.update(sessions).set({ endedAt }).where(eq(sessions.id, id)).run();
    publishRow(id);
  }

  function publishRow(id: string): void {
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
    ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, row) });
  }

  /**
   * Ends a session: the stamp, and the process stopped if there is one.
   * Stamped before the stop, not after it — the Runner's release is
   * announced with whatever the row says at that moment, and announced ahead
   * of the stamp it would show every client the session `idle` before it
   * read `ended`. The republish after covers a session with no process to
   * release.
   *
   * `unpin` clears the pin in that same write: the trash ends a pinned
   * session, and an end and an unpin sent apart gave the map a row that was
   * ended yet still pinned in between — the planet faded back in, then out.
   */
  async function endSession(id: string, opts: { unpin?: boolean } = {}): Promise<void> {
    db.update(sessions)
      .set(opts.unpin ? { endedAt: Date.now(), pinnedAt: null } : { endedAt: Date.now() })
      .where(eq(sessions.id, id))
      .run();
    await ctx.runner.stop(id);
    publishRow(id);
  }

  // End session (spec 2026-09-23-end-session-design): the header's plain
  // "close this session" — the same `endSession` that `/clear` makes, under
  // a name that says what the button does. `{ unpin: true }` is the trash's
  // drop of a pinned session: ended and unpinned in one write.
  app.post('/api/sessions/:id/end', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { unpin } = (req.body ?? {}) as { unpin?: unknown };
    const row = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not found' });
    await endSession(id, { unpin: unpin === true });
    return { ok: true };
  });

  /**
   * The trash's Undo: takes back an End (spec
   * 2026-09-24-sessions-end-only-by-hand-design § 3). The session comes back
   * `idle`, with no process — the next message revives it, as for any
   * sleeping session. A terminal session is refused: its end is the CLI
   * exiting, which no stamp here can take back.
   */
  app.post('/api/sessions/:id/reopen', (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select({ source: sessions.source }).from(sessions).where(eq(sessions.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.source !== 'web') return reply.code(409).send({ error: 'terminal_session' });
    stampEnded(id, null);
    return { ok: true };
  });

  app.post('/api/sessions/:id/clear', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { startNew } = (req.body ?? {}) as { startNew?: boolean };
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as
      | SessionRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    await endSession(id);
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
        permissionMode, model: model ?? null, lastAt: Date.now(),
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
    // The default tag leads every tag list; the rest keep creation order.
    tags: db.select(tagColumns).from(tags).orderBy(desc(tags.isDefault), tags.id).all(),
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

  // The "Other…" model card: checks an id `GET /api/models` does not list by
  // running a minimal turn on it (see `ModelCatalog.validate`). Always 200
  // once the body is well-formed — an unusable model is an answer, not a
  // failed request.
  app.post('/api/models/validate', async (req, reply) => {
    const { model } = (req.body ?? {}) as { model?: unknown };
    const id = typeof model === 'string' ? model.trim() : '';
    if (!id || /\s/.test(id) || id.length > MODEL_ID_MAX_LENGTH) {
      return reply.code(400).send({ error: 'model is required' });
    }
    return ctx.models.validate(id);
  });

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
      // Applied now, not at the next boot: the dialog confirms "this will drop
      // N sessions" before saving, and deferring the sweep would make that
      // confirmation a promise about some later restart.
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

  registerStatsRoutes(app, ctx);
}
