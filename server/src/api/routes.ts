import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseTranscript } from '../transcript/parser.js';
import { presentBranch, readTranscriptBranch, type BranchRead } from '../transcript/rewind.js';
import { RewindStore, type PendingRewind } from '../rewind/store.js';
import { regenerateRuleTags, matchRule } from '../tags/rules.js';
import { expandHome } from '../paths.js';
import { readFilePreview } from '../files/preview.js';
import { completeFilePath } from '../files/complete.js';
import { OpenTabsReader } from '../files/openTabs.js';
import { collectCommands, findCommandFile, type CatalogCommand } from '../commands/catalog.js';
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
import { statusOf, toApiSession } from './shape.js';
import type { GitStore } from '../git/store.js';
import { LINES_SETTING, PR_SETTING, type BranchStatusStore } from '../git/branchStatusStore.js';
import type { IdeStore } from '../ide/store.js';
import type { SubagentStore, SubagentTranscripts } from '../transcript/subagents.js';
import type { BackgroundTaskStore } from '../transcript/backgroundTasks.js';
import { readOutputTail } from '../files/taskOutput.js';
import { SESSION_TIPS } from '../runner/sessionInstructions.js';
import type { ChatMessage, ErrorKind, PermissionMode, SessionPurpose, SessionRow, TagRule } from '../types.js';
import { isPermissionMode } from '../types.js';
import type { ModelCatalog } from '../models/catalog.js';
import type { ErrorLog } from '../errors/log.js';
import type { ImageStore } from '../images/store.js';
import type { FileStore } from '../files/store.js';
import type { SessionTitler } from '../titler/titler.js';
import type { HarnessService } from '../harness/service.js';
import { registerHarnessRoutes, type CarryHarness } from './harness.js';
import { registerStatsRoutes } from './stats.js';
import { registerMcpRoutes } from './mcp.js';
import type { McpConfig } from '../mcp/config.js';
import { registerRemoteRoutes } from './remoteRoutes.js';
import type { RemoteService } from '../remote/service.js';
import { buildWalkthrough } from '../walkthrough/spine.js';
import { readSubagentMessages, subagentDirOf } from '../walkthrough/subagents.js';
import { StampedCache, dirStamp, fileStamp } from '../transcript/stampedCache.js';
import { buildNarrateDigest } from '../walkthrough/digest.js';
import { narrationFields } from '../walkthrough/narration.js';
import type { Narrator } from '../walkthrough/narrator.js';
import type { Spine, Walkthrough } from '../walkthrough/types.js';

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
  /** Composer attachments that are not images, read by the agent by path
   * (spec: 2026-10-01-file-attachments-design). */
  files: FileStore;
  models: ModelCatalog;
  subagents: SubagentStore;
  /** Git readings per working tree, cached and watched (spec
   * 2026-09-22-git-location-indicator-design). Read through `toApiSession`. */
  git: GitStore;
  /** Line changes and the PR per working tree, for trees a window has open
   * (spec 2026-09-30-branch-pr-and-line-changes-design). Read through
   * `toApiSession`. */
  branchStatus: BranchStatusStore;
  /** The editors open on this machine, per workspace (spec
   * 2026-09-23-ide-bridge-design). Read through `toApiSession`, and directly
   * by the open-files route. */
  ide: IdeStore;
  /** Every subagent's own transcript, keyed the same way `subagents` is — see
   * `SubagentTranscripts` (spec `2026-09-22-subagent-transcript-panel-design.md`
   * § 3). The panel's one read model. */
  subagentTranscripts: SubagentTranscripts;
  /** Every session's background tasks, with the output path each one's
   * output route may read (spec 2026-09-28-background-tasks-design §§ 2, 4). */
  backgroundTasks: BackgroundTaskStore;
  /** Every session's recent tool calls — the last 30 per session, fed from
   * tool_use blocks in the runner stream and transcript tails (spec
   * 2026-10-01-map-themes-design § 5). */
  recentTools: import('../transcript/recentTools.js').RecentToolsStore;
  errors: ErrorLog;
  /** Names a session from its own contents; here, only ever on demand. */
  titler: SessionTitler;
  /** The walkthrough's narrate queries and their stored rows (spec 2026-09-30-narrate-out-of-band-design). */
  narrator: Narrator;
  /** Harness templates and session checklists (spec 2026-09-30-session-harness-design). */
  harness: HarnessService;
  /** The mobile remote (spec 2026-09-30-mobile-remote-design § 3): its routes, and the settings hook. */
  remote: RemoteService;
  settings: { get(key: string): string; set(key: string, value: string): void };
  /** MCP config through `claude mcp`, and the read of `~/.claude.json` the edit form needs
   * (spec 2026-10-01-mcp-servers-in-the-session-design § Config). */
  mcp: McpConfig;
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
  /**
   * How long a rewind waits for a stopped session's process to exit
   * (`Runner.stopAndWait`). Tests shorten it; the Runner's default otherwise.
   */
  rewindStopTimeoutMs?: number;
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

/**
 * `/rewind`, which Orbital answers itself: the composer opens pick mode on it
 * and never sends it (spec 2026-09-29-rewind-design § Behaviour 1). Listed
 * for every session whatever the CLI reports, as the built-in it stands in
 * for; the catalog has no badge of Orbital's own.
 */
const REWIND_COMMAND: CatalogCommand = {
  name: 'rewind',
  description: 'Take the conversation back to before one of your messages',
  source: 'built-in',
};

/**
 * `/mcp`, which opens the MCP dialog and is never sent: the CLI has no
 * interactive `/mcp` under the SDK (spec
 * 2026-10-01-mcp-servers-in-the-session-design § Where it lives). Listed the
 * same way as `/rewind`.
 */
const MCP_COMMAND: CatalogCommand = {
  name: 'mcp',
  description: 'Servers for this session',
  source: 'built-in',
};

/** The commands Orbital answers itself. */
const ORBITAL_COMMANDS = [REWIND_COMMAND, MCP_COMMAND];

/** A session's command list with Orbital's own commands in it, Orbital's descriptions winning. */
function withOrbitalCommands<T extends { name: string }>(commands: T[]): Array<T | CatalogCommand> {
  const own = new Set(ORBITAL_COMMANDS.map((c) => c.name));
  return [...commands.filter((c) => !own.has(c.name)), ...ORBITAL_COMMANDS]
    .sort((a, b) => a.name.localeCompare(b.name));
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
 * The ceiling on one attachment that rides by path instead (spec:
 * 2026-10-01-file-attachments-design). The agent opens it itself and never
 * reads it whole into the context, so the limit is only what one upload
 * should hold in memory.
 */
export const FILE_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

/** The media types the image store takes — what rides as an `image` block. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * How many sessions' parsed transcripts (and, separately, walkthroughs) the
 * server keeps. A count rather than bytes, and a small one: the parsed form
 * of the largest transcripts runs to hundreds of megabytes of heap, and what
 * the cache is for is the session being paged through right now.
 */
export const TRANSCRIPT_CACHE_SESSIONS = 3;

/**
 * How many distinct directories `GET /api/projects` answers. Generous on
 * purpose: the phone's New Session picker has no file system to browse, so
 * this list is every place it can start a session without typing a path.
 */
export const PROJECTS_LIMIT = 500;

/**
 * How many session rows `GET /api/projects` reads to find `PROJECTS_LIMIT`
 * directories. A bound on the scan, not on the answer: many sessions share
 * a directory, so the answer is usually far shorter than the scan.
 */
export const PROJECTS_SCAN_ROWS = 5000;

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

/** A rewind could not stop the process holding its session; the route answers 504. */
class RewindStopError extends Error {}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;
  if (ctx.devTools) registerDevRoutes(app, ctx);
  registerRemoteRoutes(app, ctx.remote);
  /**
   * One reader for the whole server, because its whole job is to hold a tab
   * list still for a moment across the burst of requests one `@` produces
   * (spec 2026-09-23-ide-bridge-design § Open files, for `@` completion).
   */
  const openTabs = new OpenTabsReader(ctx.ide);
  /** Parsed transcripts by path, so paging back does not re-parse per page. */
  const transcriptMessages = new StampedCache<BranchRead>(TRANSCRIPT_CACHE_SESSIONS);
  /** Pending and sent rewinds (spec 2026-09-29-rewind-design § Pending rewind). */
  const rewindStore = new RewindStore(db);
  /** Walkthrough spines by transcript path; selecting a session asks for one. */
  const spines = new StampedCache<Spine>(TRANSCRIPT_CACHE_SESSIONS);
  /** Clear's harness carry-over, set once the harness routes are registered (at the end). */
  let carry: CarryHarness | null = null;

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
    // A harness drafting conversation that has ended is gone from everywhere
    // (spec 2026-10-02-harness-redesign-design § Overruled); an open one rides
    // along, marked by `purpose`, for the map alone.
    rows = rows.filter((r) => !(r.purpose === 'harness_draft' && r.ended_at !== null));
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
  function readBranchOf(id: string): BranchRead | null {
    const row = db
      .select({ project_dir: sessions.projectDir })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (!row) return null;
    const path = join(ctx.projectsDir, row.project_dir, `${id}.jsonl`);
    const stamp = fileStamp(path);
    // Cached as finished wire messages rather than raw entries, so a page
    // also skips `entriesToMessages` and the image decoding inside it. Only
    // the live branch: a rewind's abandoned turns and an interrupt's dangling
    // call stay in the file (spec 2026-09-29-rewind-design § Reading the live
    // branch). What the rewind feature reads off the branch — the pickable
    // messages, the forks — comes from the same read.
    const empty: BranchRead = { messages: [], targets: new Map(), order: new Map(), forks: [] };
    if (stamp === null) return empty;
    return transcriptMessages.get(path, stamp, () => {
      try {
        return readTranscriptBranch(parseTranscript(readFileSync(path, 'utf8')), ctx.images);
      } catch {
        return empty;
      }
    });
  }

  /**
   * Failed compactions live in the database, not the file, so they are
   * merged in at their timestamp on every read rather than cached with it
   * (spec 2026-09-28-context-compaction-design § Failure). Those at or past
   * a rewind's cut went with the turns it hid.
   */
  function withCompactionFailures(id: string, messages: ChatMessage[], cutAt: string | null): ChatMessage[] {
    let failures = db
      .select()
      .from(compactionFailures)
      .where(eq(compactionFailures.sessionId, id))
      .all() as CompactionFailureRecord[];
    const cut = cutAt === null ? NaN : Date.parse(cutAt);
    if (!Number.isNaN(cut)) failures = failures.filter((f) => f.at < cut);
    return failures.length ? mergeCompactionFailures(messages, failures) : messages;
  }

  function readTranscriptMessages(id: string): ChatMessage[] | null {
    const read = readBranchOf(id);
    return read && withCompactionFailures(id, read.messages, null);
  }

  /**
   * The transcript as the panel shows it: the live branch with a divider at
   * every rewind, cut before a pending rewind's target (spec
   * 2026-09-29-rewind-design § Pending rewind). See `presentBranch`.
   */
  function presentTranscript(id: string): ChatMessage[] | null {
    const read = readBranchOf(id);
    if (!read) return null;
    const { messages, cutAt } = presentBranch(read, {
      pendingTarget: rewindStore.pending(id)?.targetUuid ?? null,
      sent: rewindStore.sent(id),
    });
    return withHarnessMessages(id, withCompactionFailures(id, messages, cutAt));
  }

  /**
   * Marks the user entries Orbital sent on a harness's account, known by the
   * uuids recorded at delivery, so the panel draws them as Orbital's rows and
   * not the user's bubbles (spec 2026-10-02-harness-redesign-design § 3).
   * Read per request, not cached with the file: the record lives in the database.
   */
  function withHarnessMessages(id: string, messages: ChatMessage[]): ChatMessage[] {
    const ours = ctx.harness.messagesOf(id);
    if (ours.size === 0) return messages;
    return messages.map((m) => {
      const mark = m.role === 'user' && m.uuid ? ours.get(m.uuid) : undefined;
      return mark ? { ...m, harnessMessage: mark } : m;
    });
  }

  app.get('/api/sessions/:id/messages', (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const messages = presentTranscript(id);
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

  /**
   * Stops one task: a background task, or a subagent by its `task_id` — the
   * SDK's `stopTask` takes either (spec 2026-09-28-background-tasks-design
   * § 2 Stop). The route only sends the stop. The task's own
   * `task_notification` ends it, so a stop the CLI does not carry out leaves
   * the task honestly running.
   *
   * 404 for a task this session never had, or a session with no live query
   * to send it on; 409 for one that has already ended.
   */
  app.post('/api/sessions/:id/tasks/:taskId/stop', async (req, reply) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    const task = ctx.backgroundTasks.get(id, taskId);
    const agent = task ? undefined : ctx.subagents.all(id).find((a) => a.id === taskId);
    if (!task && !agent) return reply.code(404).send({ error: 'not found' });
    const ended = task ? task.state === 'ended' : agent!.state === 'ended';
    if (ended) return reply.code(409).send({ error: 'task_ended' });
    let sent: boolean;
    try {
      sent = await ctx.runner.stopTask(id, taskId);
    } catch (err) {
      // The CLI refused — most likely the task ended on its own a moment
      // before the stop reached it, and its notification is on the way.
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
    if (!sent) return reply.code(404).send({ error: 'session not running' });
    return reply.code(204).send();
  });

  /**
   * The tail of a shell's or monitor's output file (spec § 4 Reading). The
   * path comes only from the store's record for this task — the one the CLI
   * named — so no request can point this route at another file. `start` and
   * `end` are byte offsets of `text` in the file; the output topic's deltas
   * continue from `end`.
   *
   * 404 for an unknown task or one with no output file; 410 once the file is
   * gone (`/tmp` does not survive a reboot, and a finished task outlives it).
   */
  app.get('/api/sessions/:id/tasks/:taskId/output', (req, reply) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    const path = ctx.backgroundTasks.outputPath(id, taskId);
    if (!path) return reply.code(404).send({ error: 'not found' });
    const tail = readOutputTail(path);
    if (!tail) return reply.code(410).send({ error: 'output_gone' });
    return tail;
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
  /**
   * The cwd both catalog routes scan: the session's, or the New Session
   * dialog's hand-typed one. A string is the error to answer with.
   */
  function catalogCwd(q: Record<string, string>): { cwd: string; sessionId: string | null } | 'not_found' | 'missing_params' {
    if (q.session) {
      const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, q.session)).get() as
        | SessionRow
        | undefined;
      if (!row) return 'not_found';
      return { cwd: row.cwd, sessionId: q.session };
    }
    // The one door an unexpanded path comes through here, same as
    // `POST /api/sessions`: the dialog's directory field is hand-typed.
    if (q.cwd) return { cwd: expandHome(q.cwd), sessionId: null };
    return 'missing_params';
  }

  app.get('/api/commands', async (req, reply) => {
    const where = catalogCwd(req.query as Record<string, string>);
    if (where === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (where === 'missing_params') return reply.code(400).send({ error: 'missing_params' });
    const { cwd, sessionId } = where;

    const scanned = collectCommands({ claudeDir: ctx.claudeDir, cwd });
    const live = sessionId ? await ctx.runner.commands(sessionId) : null;
    if (!live) return { commands: sessionId ? withOrbitalCommands(scanned) : scanned };
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
          // Same for the hint the composer ghosts after the slug.
          ...(c.argumentHint || match?.argumentHint
            ? { argumentHint: c.argumentHint || match?.argumentHint }
            : {}),
          ...(c.aliases ? { aliases: c.aliases } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { commands: withOrbitalCommands(commands) };
  });

  /**
   * One command's file, for the composer's skill viewer (spec
   * 2026-09-30-skill-preview-design). `name` is matched against the catalog
   * scan, never joined onto a path, so this serves only what `/api/commands`
   * would list — a built-in, which has no file, is a 404 like any unknown.
   */
  app.get('/api/commands/content', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const where = catalogCwd(q);
    if (where === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (where === 'missing_params' || !q.name) return reply.code(400).send({ error: 'missing_params' });
    const found = findCommandFile({ claudeDir: ctx.claudeDir, cwd: where.cwd }, q.name.replace(/^\//, ''));
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return {
      name: found.name,
      source: found.source,
      path: found.path,
      description: found.description,
      body: found.body,
    };
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
   * An image within `ATTACHMENT_MAX_BYTES` goes into the content-addressed
   * image store and answers an `ImageRefEntry`: it rides into the turn as an
   * `image` block, and nothing on Orbital's own wire ever carries base64.
   * Everything else — an `.xlsx`, an image too big for the API — goes into the
   * file store and answers a `FileEntry`, whose path the composer puts in the
   * turn's text (spec: 2026-10-01-file-attachments-design).
   */
  async function storeAttachment(req: FastifyRequest, reply: FastifyReply) {
    // Read past the ceiling but not without limit: the 413 names the size it
    // measured, and `truncated` says when even the wall was hit, so the size
    // in the body is never read as exact.
    const part = await req.file({
      limits: { fileSize: FILE_ATTACHMENT_MAX_BYTES + 1 },
      throwFileSizeLimit: false,
    });
    if (!part) return reply.code(400).send({ error: 'missing_file' });
    const bytes = await part.toBuffer();
    if (part.file.truncated || bytes.length > FILE_ATTACHMENT_MAX_BYTES) {
      return reply.code(413).send({
        error: 'too_large',
        size: bytes.length,
        ...(part.file.truncated ? { truncated: true } : {}),
      });
    }
    if (bytes.length === 0) return reply.code(400).send({ error: 'empty_file' });
    if (IMAGE_MEDIA_TYPES.has(part.mimetype) && bytes.length <= ATTACHMENT_MAX_BYTES) {
      const entry = ctx.images.putBytes(part.mimetype, bytes);
      if (entry) return reply.code(201).send(entry);
    }
    const entry = ctx.files.putBytes(part.filename, bytes);
    if (!entry) return reply.code(400).send({ error: 'empty_file' });
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
      /**
       * Answer 400 `no_such_directory` instead of launching when `cwd` is not
       * an absolute path to an existing directory. Opt-in: the phone sends it
       * because its user types the path blind; the desktop dialog has no
       * inline place for this error yet, and its tests launch in directories
       * that do not exist against a stubbed runner.
       */
      requireDirectory?: boolean;
    };
    if (invalidAttachments(body.attachments)) {
      return reply.code(400).send({ error: 'invalid_attachment' });
    }
    // The one door an unexpanded path comes through: every other cwd in this
    // file is read back from a row this line already wrote. Expanding before
    // both the runner and the insert keeps the spawn working *and* keeps one
    // directory from appearing twice in `/api/projects`, once per spelling.
    const cwd = expandHome(body.cwd);
    // The same test the session-spawning tool makes (`ctx.runner.spawner`
    // below), answered as a code the client words for itself.
    if (body.requireDirectory === true
      && !(isAbsolute(cwd) && statSync(cwd, { throwIfNoEntry: false })?.isDirectory())) {
      return reply.code(400).send({ error: 'no_such_directory' });
    }
    // The browser may mint the id itself and subscribe to `session:<id>`
    // before it posts this, so the first turn cannot be published into a
    // topic nobody is in yet. Optional: `clear` with `startNew` and every
    // other internal caller still lets the server mint. `null` counts as
    // absent; an empty string does not — that is a client that meant to send
    // an id and sent nothing.
    const clientId = body.sessionId ?? undefined;
    const refused = clientIdRefusal(clientId);
    if (refused) return reply.code(refused.status).send({ error: refused.error });
    const sessionId = await launchSession({ ...body, cwd, sessionId: clientId });
    return reply.code(201).send({ sessionId });
  });

  /** Why a browser-minted session id cannot be used, or null when it can (or none was sent). */
  function clientIdRefusal(clientId: string | undefined): { status: number; error: string } | null {
    if (clientId === undefined) return null;
    if (!SESSION_ID_RE.test(clientId)) return { status: 400, error: 'sessionId must be a v4 UUID' };
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
    if (rowExists || ctx.runner.hasRun(clientId)) return { status: 409, error: 'session id is already taken' };
    return null;
  }

  /**
   * The back end of the `spawn_session` tool a running session calls (spec
   * 2026-09-30-a-session-spawns-sessions-design). The new session takes the
   * parent's permission mode as it stands now, and its model unless the tool
   * named one. A rejection's message is what the model reads.
   */
  ctx.runner.spawner = async (parentId, input) => {
    const permissionMode = ctx.runner.permissionModeOf(parentId);
    const parent = db.select(sessionColumns).from(sessions).where(eq(sessions.id, parentId)).get() as
      | SessionRow
      | undefined;
    if (!permissionMode || !parent) throw new Error('this session is no longer running');
    const cwd = input.cwd ? expandHome(input.cwd) : parent.cwd;
    if (!isAbsolute(cwd)) throw new Error(`cwd must be an absolute path: ${input.cwd}`);
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`no such directory: ${cwd}`);
    }
    const model = input.model?.trim() || parent.model || undefined;
    const sessionId = await launchSession({
      cwd, prompt: input.prompt, permissionMode, model, spawnedBy: parentId,
    });
    return { sessionId, cwd };
  };

  /**
   * Starts a web session and announces it: the run, the row born already
   * claimed, the optional manual tag, the `upsert` the map draws the planet
   * from. Shared by the new-session dialog's route and `spawn_session`.
   */
  async function launchSession(opts: {
    cwd: string; prompt: string; permissionMode: PermissionMode;
    tagId?: number; model?: string; resume?: string;
    sessionId?: string; attachments?: string[]; spawnedBy?: string; purpose?: SessionPurpose;
  }): Promise<string> {
    const { cwd, spawnedBy, tagId, purpose, ...start } = opts;
    const sessionId = await ctx.runner.start({ ...start, cwd });
    db.insert(sessions)
      .values({
        id: sessionId, projectDir: '', cwd, source: 'web',
        permissionMode: opts.permissionMode, model: opts.model ?? null,
        spawnedBy: spawnedBy ?? null,
        purpose: purpose ?? null,
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
    if (tagId != null) {
      db.insert(sessionTags)
        .values({ sessionId, tagId, origin: 'manual' })
        .onConflictDoNothing()
        .run();
    }
    // A browser that minted the id subscribed before this row existed, when
    // its `cwd` could not be looked up yet — so the watch starts here.
    if (ctx.hub.subscriberCount(`session:${sessionId}`) > 0) ctx.branchStatus.watchSession(sessionId, cwd);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, sessionId)).get() as SessionRow;
    ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, row) });
    return sessionId;
  }

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

  /** What a delivery did, and the uuid the turn's entry is written under when it started one. */
  interface Delivery {
    outcome: 'sent' | 'revived' | 'not_found' | 'terminal';
    uuid: string | null;
    /** The turn was the send of a pending rewind (spec 2026-09-29-rewind-design § Runner). */
    rewind?: true;
  }

  /**
   * One delivery path for anything Orbital says INTO a session: the composer's
   * text. Sends if the runner
   * holds the session; otherwise revives it by resuming — unless a terminal
   * owns it, which cannot be taken over.
   */
  async function deliverToSession(id: string, text: string, attachments?: string[]): Promise<Delivery> {
    // Writing to an ended session reopens it, whichever path below delivers
    // the message — a session someone is typing into is evidently not over
    // (spec 2026-09-24-sessions-end-only-by-hand-design § 1). Only once it
    // was delivered, though: a revive that throws leaves the session ended.
    const reopen = () => db.update(sessions).set({ endedAt: null }).where(eq(sessions.id, id)).run();
    // A pending rewind before anything else: until a turn lands, the file's
    // newest leaf is still the old branch, and a plain send or revive would
    // carry on from it (spec 2026-09-29-rewind-design § Runner).
    const pending = rewindStore.pending(id);
    if (pending) return sendRewind(id, pending, text, attachments, reopen);
    try {
      const uuid = ctx.runner.send(id, text, attachments);
      reopen();
      return { outcome: 'sent', uuid };
    } catch {
      // Inactive in the runner — revive by resuming, unless it's live in a
      // terminal (which owns the SDK process and can't be taken over).
      const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as
        | SessionRow
        | undefined;
      if (!row) return { outcome: 'not_found', uuid: null };
      if (ctx.registry.get(id)) return { outcome: 'terminal', uuid: null };
      const uuid = randomUUID();
      await revive(row, text, attachments, reopen, { promptUuid: uuid });
      return { outcome: 'revived', uuid };
    }
  }

  /**
   * Starts a sleeping (or terminal-exited) session again by resuming it with
   * this turn — plain, or truncating when `rewind` says where to fork.
   */
  async function revive(
    row: SessionRow, text: string, attachments: string[] | undefined, reopen: () => void,
    extra: Pick<Parameters<Runner['start']>[0], 'promptUuid' | 'resumeSessionAt' | 'resumeDropsTurn' | 'rewind'>,
  ): Promise<void> {
    const id = row.id;
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
        ...extra,
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
    publishRow(id);
  }

  /**
   * The send of a pending rewind (spec 2026-09-29-rewind-design § Runner):
   * whatever still runs the session is stopped and awaited, and the turn goes
   * out as a truncating resume at the fork. The pending row stays until the
   * CLI answers — `system/init` makes it a sent rewind, a refusal deletes it.
   */
  async function sendRewind(
    id: string, pending: PendingRewind, text: string, attachments: string[] | undefined, reopen: () => void,
  ): Promise<Delivery> {
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as
      | SessionRow
      | undefined;
    if (!row) return { outcome: 'not_found', uuid: null };
    if (ctx.registry.get(id)) return { outcome: 'terminal', uuid: null };
    await stopForRewind(id);
    const uuid = randomUUID();
    await revive(row, text, attachments, reopen, {
      promptUuid: uuid,
      resumeSessionAt: pending.forkUuid,
      resumeDropsTurn: pending.dropsTurn ?? undefined,
      rewind: {
        started: () => rewindStarted(id),
        refused: (message) => rewindRefused(id, message),
      },
    });
    return { outcome: 'revived', uuid, rewind: true };
  }

  /**
   * Stops the session and waits for its process to be gone. A timeout is
   * recorded and thrown as `RewindStopError` — failing the rewind visibly
   * rather than racing a second process onto the same transcript.
   */
  async function stopForRewind(id: string): Promise<void> {
    try {
      await ctx.runner.stopAndWait(id, ctx.rewindStopTimeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.errors.record({
        source: 'server',
        kind: 'rewind_failed',
        sessionId: id,
        message: `Rewind failed: ${message}`,
        detail: err instanceof Error ? (err.stack ?? null) : null,
        context: { while: 'stopping the session for a rewind' },
      });
      throw new RewindStopError(message);
    }
  }

  /** Tells every window on the session to read its transcript again. */
  function publishReset(id: string): void {
    ctx.hub.publish(`session:${id}`, { event: 'transcript_reset' });
  }

  /**
   * A pending rewind's edges move the status of a session nobody runs
   * (`statusOf`), which no Runner transition announces: the map hears it
   * through the row, the panel on its own topic.
   */
  function publishRewindEdge(id: string): void {
    publishReset(id);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow | undefined;
    if (!row) return;
    ctx.hub.publish(`session:${id}`, { event: 'status', status: statusOf(ctx, row) });
    ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, row) });
  }

  /**
   * The CLI took the truncating resume (spec 2026-09-29-rewind-design §
   * After a rewind is sent): the pending row becomes a sent one, the context
   * reading of the dropped branch goes, and the titler forgets the dropped
   * turns.
   */
  function rewindStarted(id: string): void {
    if (!rewindStore.promote(id)) return;
    db.update(sessions).set({ contextUsedTokens: null }).where(eq(sessions.id, id)).run();
    const shown = presentTranscript(id);
    if (shown) ctx.titler.reset(id, shown);
    publishReset(id);
    publishRow(id);
  }

  /**
   * The CLI refused the truncating resume. Nothing was sent and nothing
   * written; the rewind is undone, and the client — told by `rewind_refused`
   * — keeps the edited text as an ordinary draft. Never retried: the refusal
   * is deterministic.
   */
  function rewindRefused(id: string, message: string): void {
    const pending = rewindStore.takePending(id);
    const restored = pending
      ? `${pending.hiddenCount} hidden message${pending.hiddenCount === 1 ? '' : 's'} restored`
      : 'nothing to restore';
    ctx.errors.record({
      source: 'server',
      kind: 'rewind_refused',
      sessionId: id,
      message: `The CLI refused the rewind; ${restored}`,
      detail: message,
      context: pending
        ? {
            targetUuid: pending.targetUuid, forkUuid: pending.forkUuid,
            dropsTurn: pending.dropsTurn, hiddenCount: pending.hiddenCount,
          }
        : null,
    });
    ctx.hub.publish(`session:${id}`, {
      event: 'rewind_refused', message, hiddenCount: pending?.hiddenCount ?? null,
    });
    publishRewindEdge(id);
  }

  /** What only Orbital answers: sent as a message, it would reach the agent as text. */
  const LOCAL_COMMANDS = new Set(ORBITAL_COMMANDS.map((c) => `/${c.name}`));

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text, attachments } = req.body as { text: string; attachments?: string[] };
    if (invalidAttachments(attachments)) {
      return reply.code(400).send({ error: 'invalid_attachment' });
    }
    // The client opens pick mode on `/rewind`; one that sends it anyway must
    // not hand the agent the word (spec 2026-09-29-rewind-design § Behaviour 1).
    if (typeof text === 'string' && LOCAL_COMMANDS.has(text.trim())) {
      return reply.code(400).send({ error: 'local_command' });
    }
    let delivery: Delivery;
    try {
      delivery = await deliverToSession(id, text, attachments);
    } catch (err) {
      if (err instanceof RewindStopError) return reply.code(504).send({ error: 'stop_timeout', message: err.message });
      throw err;
    }
    return deliveryReply(delivery, reply, 'session is live in a terminal');
  });

  /**
   * The answer every turn-sending route gives. `uuid` names the turn's
   * transcript entry — the client holds its own copy of the turn, which the
   * Runner never publishes, and a rewind needs the name.
   */
  function deliveryReply(delivery: Delivery, reply: FastifyReply, terminalError: string) {
    if (delivery.outcome === 'not_found') return reply.code(404).send({ error: 'not found' });
    if (delivery.outcome === 'terminal') return reply.code(409).send({ error: terminalError });
    return {
      ok: true,
      ...(delivery.outcome === 'revived' ? { revived: true } : {}),
      ...(delivery.uuid ? { uuid: delivery.uuid } : {}),
      ...(delivery.rewind ? { rewind: true } : {}),
    };
  }

  // ---- Rewind (spec: 2026-09-29-rewind-design) ---------------------------

  /**
   * Picks a rewind: the conversation goes back to just before one of the
   * user's messages, pending until the next send. The client has already
   * asked whether to stop a working session, so a live query is stopped —
   * and its process awaited — before the row is stored.
   *
   * 400 for a malformed body, 404 for an unknown session, 409 for a session
   * a terminal holds (`terminal_session`), one with a rewind already pending
   * (`rewind_pending`) or a uuid that is not a pickable entry of the live
   * branch (`not_rewindable`), 504 when the process would not stop.
   */
  app.post('/api/sessions/:id/rewind', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { uuid?: unknown; hiddenCount?: unknown; draft?: unknown };
    if (typeof body.uuid !== 'string' || !body.uuid) {
      return reply.code(400).send({ error: 'uuid is required' });
    }
    if (typeof body.hiddenCount !== 'number' || !Number.isSafeInteger(body.hiddenCount) || body.hiddenCount < 0) {
      return reply.code(400).send({ error: 'hiddenCount must be a non-negative integer' });
    }
    if (body.draft !== undefined && typeof body.draft !== 'string') {
      return reply.code(400).send({ error: 'draft must be a string' });
    }
    const uuid = body.uuid;
    const refused = () => {
      if (ctx.registry.get(id)) return reply.code(409).send({ error: 'terminal_session' });
      if (rewindStore.pending(id)) return reply.code(409).send({ error: 'rewind_pending' });
      if (!readBranchOf(id)?.targets.has(uuid)) return reply.code(409).send({ error: 'not_rewindable' });
      return null;
    };
    if (!db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get()) {
      return reply.code(404).send({ error: 'not found' });
    }
    const early = refused();
    if (early) return early;
    try {
      await stopForRewind(id);
    } catch (err) {
      if (err instanceof RewindStopError) return reply.code(504).send({ error: 'stop_timeout', message: err.message });
      throw err;
    }
    // Asked again: the stopped turn may have written on, and another window
    // may have picked while this one waited.
    const late = refused();
    if (late) return late;
    const target = readBranchOf(id)!.targets.get(uuid)!;
    rewindStore.createPending({
      sessionId: id,
      targetUuid: uuid,
      forkUuid: target.forkUuid,
      dropsTurn: target.newest ? uuid : null,
      hiddenCount: body.hiddenCount,
      text: target.text,
      priorDraft: typeof body.draft === 'string' ? body.draft : '',
      createdAt: Date.now(),
    });
    publishRewindEdge(id);
    return { text: target.text };
  });

  /** Cancels a pending rewind; the composer gets back the draft it held before the pick. */
  app.delete('/api/sessions/:id/rewind', (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get()) {
      return reply.code(404).send({ error: 'not found' });
    }
    const pending = rewindStore.takePending(id);
    if (!pending) return reply.code(404).send({ error: 'no_rewind_pending' });
    publishRewindEdge(id);
    return { draft: pending.priorDraft };
  });

  // ---- Walkthrough (spec: 2026-09-23-walkthrough-design) ----------------

  function spineFor(id: string): { row: SessionRow; spine: Spine; transcriptPath: string } | null {
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow | undefined;
    if (!row) return null;
    const transcriptPath = join(ctx.projectsDir, row.project_dir, `${id}.jsonl`);
    // The subagents' files feed the walkthrough too, so they are part of the
    // stamp: an agent that writes on changes it while the parent file sits
    // still.
    const stamp = `${fileStamp(transcriptPath) ?? '-'}#${dirStamp(subagentDirOf(transcriptPath))}`;
    const spine = spines.get(transcriptPath, stamp, () =>
      buildWalkthrough(readTranscriptMessages(id) ?? [], readSubagentMessages(transcriptPath, ctx.images)),
    );
    return { row, spine, transcriptPath };
  }

  /**
   * The spine with its narration. The narration is read per request, never
   * cached with the spine: it changes when a query lands, not when the
   * transcript does (spec 2026-09-30-narrate-out-of-band-design § Storage
   * and state).
   */
  function walkthroughOf(id: string, spine: Spine): Walkthrough {
    return { ...spine, ...narrationFields(ctx.narrator.state(id), spine.steps.map((s) => s.id)) };
  }

  app.get('/api/sessions/:id/walkthrough', (req, reply) => {
    const { id } = req.params as { id: string };
    const found = spineFor(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    return { session: toApiSession(ctx, found.row), walkthrough: walkthroughOf(id, found.spine) };
  });

  /** The header's entry control asks this; it is the same parse, smaller answer. */
  app.get('/api/sessions/:id/walkthrough/summary', (req, reply) => {
    const { id } = req.params as { id: string };
    const found = spineFor(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    const w = found.spine;
    return {
      steps: w.steps.length,
      files: w.files.length,
      blindAlleys: w.steps.filter((s) => s.fate.some((f) => f.kind === 'reverted')).length,
      subagents: w.steps.filter((s) => s.subagent !== null).length,
    };
  });

  /**
   * Starts a narrate query and answers before it runs (spec
   * 2026-09-30-narrate-out-of-band-design § The query). Nothing is sent into
   * the session, so a running, ended or terminal session narrates the same;
   * the one refusal besides an empty walkthrough is a query already in
   * flight for it. The page hears the row change on `session:<id>` — now,
   * as it goes pending, and again when the narrator finishes.
   */
  app.post('/api/sessions/:id/walkthrough/narrate', (req, reply) => {
    const { id } = req.params as { id: string };
    const found = spineFor(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    if (found.spine.steps.length === 0) return reply.code(400).send({ error: 'no_steps' });
    if (ctx.narrator.running(id)) return reply.code(409).send({ error: 'narrate_running' });
    const digest = buildNarrateDigest(
      found.spine,
      readTranscriptMessages(id) ?? [],
      readSubagentMessages(found.transcriptPath, ctx.images),
    );
    void ctx.narrator.start(id, digest, found.spine.steps.map((s) => s.id));
    ctx.hub.publish(`session:${id}`, { event: 'walkthrough_narration' });
    return reply.code(202).send({ ok: true });
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

  app.post('/api/sessions/:id/permission-mode', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { mode } = (req.body ?? {}) as { mode?: unknown };
    if (!isPermissionMode(mode)) {
      return reply.code(400).send({ error: 'mode must be a permission mode' });
    }
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as
      | SessionRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    // Same rule as the model switch: a terminal-owned session is not ours.
    if (ctx.registry.get(id)) {
      return reply.code(409).send({ error: 'session is live in a terminal' });
    }
    if (ctx.runner.status(id)) {
      await ctx.runner.setPermissionMode(id, mode);
    }
    // An ended session keeps the choice too: the revive resumes in it.
    db.update(sessions).set({ permissionMode: mode }).where(eq(sessions.id, id)).run();
    publishRow(id);
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
    // A harness with steps left pauses, "session ended in step N", ready to be
    // carried into a new session from Clear (spec 2026-10-02-harness-redesign-design § 8).
    ctx.harness.sessionEnded(id);
    await ctx.runner.stop(id);
    publishRow(id);
    // An ended drafting conversation is gone from everywhere, the map included.
    const ended = db.select({ purpose: sessions.purpose }).from(sessions).where(eq(sessions.id, id)).get();
    if (ended?.purpose === 'harness_draft') ctx.hub.publish('sessions', { event: 'remove', sessionId: id });
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
    // `carryHarness`: the new session takes the old one's harness and is sent
    // its current step (spec 2026-10-02-harness-redesign-design § 8).
    const { startNew, carryHarness } = (req.body ?? {}) as { startNew?: boolean; carryHarness?: boolean };
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
    if (carryHarness !== true) return { ok: true, sessionId: newId };
    const harnessCarried = !!carry && ctx.settings.get('harness_enabled') === 'true' && !!ctx.harness.get(id)
      && (await carry(id, newId)).ok;
    return { ok: true, sessionId: newId, harnessCarried };
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
        lastAt: sessions.lastAt,
      })
      .from(sessions)
      .where(ne(sessions.cwd, ''))
      .orderBy(desc(sessions.lastAt))
      .limit(PROJECTS_SCAN_ROWS)
      .all();
    const projects: Array<{ cwd: string; lastModel: string | null; lastAt: number | null }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.cwd)) continue;
      seen.add(row.cwd);
      projects.push({
        cwd: row.cwd,
        lastModel: row.model ?? row.resolvedModel ?? null,
        lastAt: row.lastAt ?? null,
      });
      if (projects.length === PROJECTS_LIMIT) break;
    }
    return { projects };
  });

  // What the New Session dialog pre-sets, as three values and nothing more.
  // It exists for the phone: `/api/settings` is denied to it (the remote
  // allowlist), and these three are all 9d needs from the settings table.
  // Readings mirror the web's `NewSessionDialog`; `DEFAULT_SETTINGS` seeds
  // every key, so the fallbacks only answer a table someone emptied.
  app.get('/api/sessions/defaults', () => ({
    permissionMode: (ctx.settings.get('default_permission_mode') || 'acceptEdits') as PermissionMode,
    model: ctx.settings.get('default_model') || null,
    rememberModelPerProject: ctx.settings.get('remember_model_per_project') !== 'false',
  }));

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
    let branchSettings = false;
    let remoteRestart = false;
    let remoteName = false;
    for (const [k, v] of Object.entries(req.body as Record<string, string>)) {
      // A restart of the remote drops every connected phone; saving a value
      // that did not change must not do that.
      if (k.startsWith('remote_') && ctx.settings.get(k) !== String(v)) {
        if (k === 'remote_mac_name') remoteName = true;
        else remoteRestart = true;
      }
      ctx.settings.set(k, String(v));
      // Applied now, not at the next boot: the dialog confirms "this will drop
      // N sessions" before saving, and deferring the sweep would make that
      // confirmation a promise about some later restart.
      if (k === RETENTION_KEY) ctx.retention.sweep();
      if (k === PR_SETTING || k === LINES_SETTING) branchSettings = true;
    }
    // Without a reload: a switch turned off drops the field from the open
    // sessions, one turned on starts reading and fills it.
    if (branchSettings) ctx.branchStatus.settingsChanged();
    // The switch, the relay URL and the relay secret apply now, not at the next boot. The Mac's
    // name restarts nothing: the service reads it fresh for every pairing
    // code, and a restart would drop every phone session and an open code at
    // each pause in typing. It only republishes the status that shows it.
    if (remoteRestart) ctx.remote.settingsChanged();
    else if (remoteName) ctx.remote.nameChanged();
    return { ok: true };
  });

  // Settings › Sessions › INSTRUCTIONS reads the tip list from here, never
  // from a copy in the web bundle: the preview must show what the running
  // server sends (spec 2026-09-30-session-instructions-design § 4).
  app.get('/api/session-instructions/tips', () => ({ tips: SESSION_TIPS }));

  /**
   * Whether `gh` can serve the PR switch, and if not, why — asked when
   * Settings opens and when the app regains focus (spec
   * 2026-09-30-branch-pr-and-line-changes-design § Settings).
   */
  app.get('/api/gh-status', async () => ({ status: await ctx.branchStatus.ghStatus() }));

  /**
   * The app regained focus: look again at the PR and the lines of every
   * working tree a window has open. Answers at once; the readings arrive as
   * session upserts.
   */
  app.post('/api/branch-status/refresh', () => {
    ctx.branchStatus.refreshAll();
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
  registerMcpRoutes(app, ctx);
  carry = registerHarnessRoutes(app, ctx, deliverToSession, readTranscriptMessages, async (opts) => {
    const refused = clientIdRefusal(opts.sessionId);
    if (refused) return { ok: false, ...refused };
    return { ok: true, sessionId: await launchSession({ ...opts, cwd: expandHome(opts.cwd) }) };
  }).carryHarness;
}
