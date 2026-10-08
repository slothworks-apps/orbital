import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { CONFIG } from './config.js';
import { applyLoginShellPath } from './env/loginPath.js';
import { FIRST_CLAUDE_DIR_ID, cliDefaultDir } from './claudeDirs/paths.js';
import { ClaudeDirsService, seedClaudeDirs, type ClaudeDir } from './claudeDirs/service.js';
import {
  countSweepable,
  parseRetentionDays,
  retentionCutoff,
  sweepSessions,
  RETENTION_KEY,
} from './retention.js';
import { openDb } from './db/database.js';
import { compactionFailures, pendingRewinds, sessionColumns, sessions, settings as settingsTable } from './db/schema.js';
import { indexPaths, indexProjects, type IndexOwner } from './indexer/indexer.js';
import { batchSessionIds, watchProjects } from './watcher/projects.js';
import { LiveRegistries, SessionRegistry, type LiveSession } from './watcher/registry.js';
import { TranscriptTail } from './watcher/tail.js';
import { LiveSessionStats } from './watcher/liveStats.js';
import { recordPermissionWait } from './stats/store.js';
import { Hub } from './api/hub.js';
import { Runner, type QueryFn } from './runner/runner.js';
import { resolveClaudeCodeVersion } from './runner/version.js';
import { claudeCliVersion, resolveClaudeCli, sdkBundledCliAvailable, sdkBundledCliPath } from './runner/claudeCli.js';
import { McpConfig } from './mcp/config.js';
import { claudeJsonPath } from './mcp/claudeJson.js';
import { GitStore } from './git/store.js';
import { WorkingTrees } from './git/workingTrees.js';
import { BranchStatusStore } from './git/branchStatusStore.js';
import { IdeStore } from './ide/store.js';
import { ideApprovals } from './ide/approvals.js';
import { registerRoutes, type RouteClaudeDirContext } from './api/routes.js';
import { listedBackgroundTasks, listedSubagents, statusOf, toApiSession, type ShapeContext } from './api/shape.js';
import { entriesToMessages } from './transcript/parser.js';
import { SubagentStore, SubagentTranscripts } from './transcript/subagents.js';
import { BackgroundTaskStore } from './transcript/backgroundTasks.js';
import { RecentToolsStore } from './transcript/recentTools.js';
import { OutputFollower } from './files/taskOutput.js';
import { SessionTitler, type TitleQueryFn } from './titler/titler.js';
import { HarnessService } from './harness/service.js';
import { askWatcher } from './harness/watcher.js';
import { askOnce } from './harness/ask.js';
import { DRAFT_SYSTEM_PROMPT } from './harness/drafter.js';
import { askReviewer } from './harness/reviewer.js';
import { gateOf } from './harness/logic.js';
import type { HarnessGate } from './harness/types.js';
import { Narrator, type NarrateQueryFn } from './walkthrough/narrator.js';
import { composeAppendix } from './runner/sessionInstructions.js';
import { ModelCatalog, catalogKeyFor, recordContextWindows } from './models/catalog.js';
import { LIMITS_TOPIC, LimitsService } from './limits/service.js';
import { ErrorLog } from './errors/log.js';
import { createImageStore } from './images/store.js';
import { RemoteService } from './remote/service.js';
import { remoteInjectOptions } from './remote/inject.js';
import {
  API_TOKEN_COOKIE,
  loadOrCreateApiToken,
  safeNext,
  tokenFromBearer,
  tokenFromCookie,
  tokenMatches,
} from './auth/token.js';
import { createFileStore } from './files/store.js';
import type { SessionRow } from './types.js';

/**
 * Publishes a REST-shaped `ApiSession` on the `sessions` topic for a live
 * terminal-registry session, so WS consumers get the same shape for both
 * terminal-registry upserts and web-session creation (final-review ruling).
 *
 * `live.status` is passed straight through as the status override rather
 * than recomputed via `ctx.registry`: this runs from `registry.on('upsert')`
 * while the registry's internal map still holds the *previous* scan's
 * state (it swaps in the new map only after emitting), so `ctx.registry.get`
 * would not yet reflect `live` here.
 */
export function publishLiveSession(ctx: PublishContext, live: LiveSession): void {
  const row = ctx.db
    .select(sessionColumns)
    .from(sessions)
    .where(eq(sessions.id, live.sessionId))
    .get() as SessionRow | undefined;
  const session = row
    ? toApiSession(ctx, row, live.status)
    : rowlessSession(ctx, live);
  ctx.hub.publish('sessions', { event: 'upsert', session });
}

/** A live session whose row has not landed yet, in the listed shape `toApiSession` gives the rest. */
function rowlessSession(ctx: PublishContext, live: LiveSession) {
  const agents = ctx.subagents.all(live.sessionId);
  const tasks = ctx.backgroundTasks.all(live.sessionId);
  return {
    id: live.sessionId, cwd: live.cwd, workingDir: live.cwd, otherTrees: [], title: live.name, firstAt: null,
    lastAt: live.updatedAt, messageCount: 0, source: 'terminal' as const,
    permissionMode: null, tagIds: [], status: live.status,
    subagents: listedSubagents(agents),
    subagentCount: agents.length,
    backgroundTasks: listedBackgroundTasks(tasks),
    backgroundTaskCount: tasks.length,
    recentTools: ctx.recentTools.all(live.sessionId),
    claudeDirId: live.claudeDirId ?? FIRST_CLAUDE_DIR_ID,
  };
}

/** What it takes to put a session on the `sessions` topic. */
export type PublishContext = ShapeContext & { hub: Hub };

/**
 * Republishes one session because something about it changed that lives
 * outside its DB row — today, its subagents. An agent FINISHING is one of
 * the changes this exists to publish: the upsert carries only the running
 * agents (`listedSubagents`), so the finished one drops out of it, and a
 * client showing that session reads how it ended from `GET /api/sessions/:id`
 * (subagent list spec § 3, adr: subagentstore-splits-into-all-and-running).
 *
 * Subagents ride along in the session shape rather than on a topic of their
 * own, so the map sees them for every session (not only the selected one)
 * and a page reload gets them from `GET /api/sessions` like everything else.
 */
export function publishSession(ctx: PublishContext, sessionId: string): void {
  const live = ctx.registry.get(sessionId);
  if (live) return publishLiveSession(ctx, live);
  const row = ctx.db
    .select(sessionColumns)
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get() as SessionRow | undefined;
  if (!row) return;
  ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, row) });
}

/**
 * Whether a session has to hear about a change to its directory's ambient
 * state — a `HEAD` that moved, an editor selection, an editor opening or
 * closing — as it happens.
 *
 * A live session does: the map and the composer act on it now. So does any
 * session a window has open (`session:<id>` has a subscriber), ended ones
 * included, because the header shows its branch and its composer sends the
 * editor selection along with a continued conversation. Every other ended
 * session is skipped. A workspace can hold well over a hundred of them, and
 * a selection drag would otherwise republish all of them per flush (audit
 * resource-usage-pass-2026-09-24, finding 4). The first subscriber to a
 * session's topic republishes it, so opening one later picks up whatever it
 * missed.
 */
export function wantsAmbientUpdates(ctx: PublishContext, sessionId: string): boolean {
  const owned = ctx.runner.status(sessionId);
  if (owned !== undefined && owned !== 'ended') return true;
  if (ctx.registry.get(sessionId)) return true;
  return ctx.hub.subscriberCount(`session:${sessionId}`) > 0;
}

/**
 * Republishes the sessions sitting in these directories whose ambient state
 * anyone is looking at (`wantsAmbientUpdates`). Neither a branch switch nor a
 * selection changes a session row, so both are turned back into sessions
 * here and published the way every other session change is.
 */
export function republishCwds(ctx: PublishContext, cwds: string[]): void {
  if (cwds.length === 0) return;
  const rows = ctx.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.cwd, cwds))
    .all();
  // Those whose home it is, and those working there now — in their own tree
  // or a running subagent's (spec 2026-10-07-live-working-tree-design § 3).
  const ids = new Set([...rows.map((row) => row.id), ...(ctx.trees?.sessionsAt(cwds) ?? [])]);
  for (const id of ids) {
    if (wantsAmbientUpdates(ctx, id)) publishSession(ctx, id);
  }
}

/**
 * Where `npm run dev` serves the web app (`web/vite.config.ts` pins it with
 * `strictPort`, and `desktop/src/lib/startup.ts` points the window there).
 * Deliberately not vite's default 5173, which other projects' dev servers
 * hold: a page of theirs must not be able to open this socket.
 */
export const DEV_WEB_PORT = 4839;

/**
 * Cross-site WebSocket hijacking guard (C2): the browser always sends an
 * Origin header for a WS handshake initiated from a page, so only our own
 * dev/prod origins may open /ws. Non-browser clients (CLI tools, tests) send
 * no Origin at all and are allowed through — there's no cookie-based session
 * to hijack, this only blocks a foreign *page* silently opening our socket.
 */
export function isAllowedWsOrigin(origin: string | undefined | null, port: number): boolean {
  if (!origin) return true;
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${DEV_WEB_PORT}`,
    `http://localhost:${DEV_WEB_PORT}`,
  ]);
  return allowed.has(origin);
}

/**
 * DNS-rebinding guard (I5): a page served from an attacker-controlled domain
 * that resolves to 127.0.0.1 could otherwise reach the REST API as if it
 * were same-origin. Only accept requests whose Host header names this
 * machine. Port is ignored (fastify's inject() defaults to `localhost:80`
 * regardless of the app's configured port), since the attack is about the
 * hostname, not the port.
 */
export function isAllowedHost(hostHeader: string | undefined | null): boolean {
  if (!hostHeader) return true;
  const hostname = hostHeader.split(':')[0].toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export async function buildServer(overrides: {
  dbPath?: string;
  /** The first Claude directory's path, over `ORBITAL_CLAUDE_DIR` and the row. Tests only. */
  claudeDir?: string;
  queryFn?: QueryFn;
  /** The titler's one-shot call. Its own seam: it sends a whole prompt, not a stream. */
  titleQueryFn?: TitleQueryFn;
  /** The walkthrough's narrate call — one-shot, like the titler's. */
  narrateQueryFn?: NarrateQueryFn;
  /**
   * Built frontend to serve same-origin (`web/dist`). Unset in dev and tests,
   * where Vite serves it on DEV_WEB_PORT and proxies `/api` and `/ws` here.
   */
  staticDir?: string;
  /**
   * Registers the dev-only routes (the compaction simulation). Defaults to
   * `ORBITAL_DEV_TOOLS=1`, which only the root `dev:server` script sets —
   * so the packaged app and the test suite never have them.
   */
  devTools?: boolean;
  /** How long a rewind waits for a stopped process; tests shorten it (see `Runner.stopAndWait`). */
  rewindStopTimeoutMs?: number;
  /** Where the identity file and images live; tests point it at a temp dir. */
  dataDir?: string;
  /**
   * The token `/api` and `/ws` require (`auth/token.ts`). Only tests may
   * leave it out, which turns the guard off; the entry point below always
   * loads one, and anything else without it refuses to start.
   */
  apiToken?: string;
} = {}): Promise<FastifyInstance> {
  const apiToken = overrides.apiToken;
  if (apiToken === undefined && !process.env.VITEST) {
    throw new Error('buildServer needs an apiToken outside the test suite');
  }
  // Web sessions must bill the user's Claude subscription (CLI OAuth). The
  // spawned CLI prefers ANTHROPIC_API_KEY over OAuth when present, so strip
  // it unless the operator explicitly opts into API-key billing.
  //
  // The decision is recorded because Settings → General reports it: where the
  // money goes is worth stating somewhere the user can find, and it is an
  // environment decision made once here rather than a preference they can
  // click — a toggle for "start charging my card" is not a toggle.
  const billing: 'api-key' | 'subscription' =
    process.env.ORBITAL_USE_API_KEY === '1' ? 'api-key' : 'subscription';
  if (billing !== 'api-key') delete process.env.ANTHROPIC_API_KEY;
  // The other half of the environment this server depends on: launched from
  // Finder it inherits `/usr/bin:/bin:/usr/sbin:/sbin`, where neither `claude`
  // nor the git/npm a session shells out to can be found. Gated, so only the
  // packaged app pays for the login-shell spawn (spec § 3).
  await applyLoginShellPath();

  // The database comes up FIRST, before anything that might be configured
  // from it. `dbPath` hangs off `dataDir`, which no setting can move, so
  // there is no cycle here — but the Claude directories below are stored
  // rows, and they cannot be read before the table they live in exists.
  //
  // `ORBITAL_MIGRATIONS_DIR` is how the packaged app points at its unpacked
  // `drizzle/` resources; unset everywhere else, where the default is right.
  const db = openDb(overrides.dbPath ?? CONFIG.dbPath, process.env.ORBITAL_MIGRATIONS_DIR || undefined);

  // Single accessor shared by the model catalog (which persists its probed
  // list and learned context windows into settings) and the routes' own
  // GET/PATCH /api/settings — two objects hitting the same table would be a
  // silent duplicate of one job.
  const settingsStore = {
    get: (key: string) =>
      db.select({ value: settingsTable.value }).from(settingsTable)
        .where(eq(settingsTable.key, key)).get()?.value ?? '',
    set: (key: string, value: string) =>
      void db.insert(settingsTable).values({ key, value })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value } }).run(),
  };

  // The Claude directories (spec 2026-10-04-multiple-claude-directories-design
  // § 1): row 1 is seeded from what the single-directory server watched. Their
  // contexts start further down, once everything a context feeds exists.
  seedClaudeDirs(db);
  const hub = new Hub();
  // One log for both sides of the wire; it publishes its own changes on the
  // `errors` topic, so it needs the hub and nothing else.
  const errors = new ErrorLog({ db, hub });
  // Every directory's live CLI registry, read as one; each context adds its own.
  const registry = new LiveRegistries();

  // Which `claude` this server will spawn, decided once at boot: the runner
  // gets the path, `GET /api/health` gets the source so the desktop app can
  // raise its missing-CLI dialog (spec 2026-09-16-electron-wrapper-design §3).
  const claudeCli = resolveClaudeCli({
    override: settingsStore.get('claude_executable_path'),
    bundled: sdkBundledCliAvailable(),
    pathVar: process.env.PATH,
    home: homedir(),
    exists: existsSync,
  });

  // Resolve the Claude Code version once, at boot, into the settings table —
  // `/api/settings` already passes arbitrary keys through, so the Settings
  // panel's `claude-code <v>` line lights up with no new endpoint. When it
  // can't be resolved the row is *removed* rather than left stale or filled
  // with a placeholder, so the UI hides the line instead of lying about it.
  //
  // The manifest only describes the SDK's own bundled binary, so anything
  // else has to be asked directly.
  const claudeCodeVersion =
    claudeCli.source === 'bundled' ? resolveClaudeCodeVersion()
    : claudeCli.path ? await claudeCliVersion(claudeCli.path)
    : null;
  if (claudeCodeVersion) {
    db.insert(settingsTable)
      .values({ key: 'claude_code_version', value: claudeCodeVersion })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: claudeCodeVersion } })
      .run();
  } else {
    db.delete(settingsTable).where(eq(settingsTable.key, 'claude_code_version')).run();
  }

  // `claudeDirs` is built below, once everything its contexts start exists;
  // nothing here calls these before that.
  /**
   * The directory a session belongs to: the one the Runner started it under,
   * else its row's, else the registry's for a terminal session not indexed
   * yet, else the default.
   */
  const dirOfSession = (sessionId: string): number =>
    runner.claudeDirOf(sessionId) ??
    db.select({ id: sessions.claudeDirId }).from(sessions).where(eq(sessions.id, sessionId)).get()?.id ??
    registry.dirOf(sessionId) ??
    claudeDirs.defaultId();
  /**
   * The environment for a CLI under this directory. One no longer configured
   * runs under the default's: the env is always built, so the server's own
   * `CLAUDE_CONFIG_DIR` can never reach a spawn.
   */
  const envForDir = (claudeDirId: number): Record<string, string> | undefined =>
    claudeDirs.envFor(claudeDirId) ?? claudeDirs.envFor(claudeDirs.defaultId());
  const envForSession = (sessionId: string) => envForDir(dirOfSession(sessionId));

  // Usage limits (spec 2026-10-03-usage-limits-design): the probe behind the
  // limits view, and the waits that continue a session after a reset. With an
  // API key there are no plan windows, so nothing is probed and nothing waits.
  // `republish` and `errors` are declared below; both are only called later.
  const limits: LimitsService = new LimitsService({
    db,
    hub,
    settings: settingsStore,
    queryFn: overrides.queryFn ?? (query as unknown as QueryFn),
    tracked: billing !== 'api-key',
    cwd: process.cwd(),
    claudeExecutablePath: claudeCli.path,
    // One plan per directory: each is probed under its own login.
    claudeDirs: {
      list: () => claudeDirs.list().map(({ id, name }) => ({ id, name })),
      envFor: envForDir,
      dirOf: dirOfSession,
    },
    republish: (sessionId) => republish(sessionId),
    onError: (err, during, sessionId) =>
      errors.record({
        source: 'server',
        kind: 'api_request',
        sessionId: sessionId ?? null,
        message: err instanceof Error ? err.message : String(err),
        detail: err instanceof Error ? (err.stack ?? null) : null,
        context: { while: during },
      }),
  });
  limits.load();

  // Every session's subagents, keyed by session — running and ended alike,
  // since the subagent list keeps finished rows (subagent list spec § 5). Read back
  // out through `toApiSession`, so a change means "republish the session".
  //
  // Only the runner ever feeds this, from the SDK's task events, i.e. only
  // orbital's own sessions have subagents. Neither a transcript nor the tool
  // blocks can answer the question: an `Agent` runs in the background and its
  // tool_result comes back at launch. See
  // `docs/domains/subagents-in-transcripts.md` and
  // `docs/decisions/subagent-liveness-from-sdk-task-events.md`.
  const subagents = new SubagentStore();
  // Every subagent's own transcript, buffered off the frames `pump()` routes
  // by `parent_tool_use_id` instead of onto `session:<id>` — the panel's
  // read model, catch-up for one opened mid-run, and freeze target once the
  // agent ends. Deliberately its own store rather than living inside
  // `subagents` above: a tracker's entry is about an agent's LIFECYCLE and
  // this buffer's whole point is to be indifferent to it — nothing here
  // reads `working`/`ended` at all, so nothing can clear a transcript
  // because its agent finished (spec
  // `2026-09-22-subagent-transcript-panel-design.md` § 3, adr:
  // subagent-buffer-outlives-the-agent).
  const subagentTranscripts = new SubagentTranscripts();
  // Every session's background tasks — shells, monitors, workflows, MCP
  // tasks — fed by the same task events as `subagents`, but kept in SQLite:
  // ended tasks and their output outlive a restart (spec
  // 2026-09-28-background-tasks-design § 2). Loading ends whatever the
  // previous server left running. Its `onChange` is a late exit code, and
  // `republish` is only called once the runner below exists.
  const backgroundTasks = new BackgroundTaskStore({ db, onChange: (sessionId) => republish(sessionId) });
  backgroundTasks.load();
  // Every session's recent tool calls — the last 30 per session, in-memory
  // only, fed from tool_use blocks in both the runner stream and transcript
  // tails. Dropped when a session ends (spec 2026-10-01-map-themes-design § 5).
  const recentTools = new RecentToolsStore();
  // Built on call, not up front: the runner it names is constructed below and
  // is itself one of the things that asks for a republish.
  // Where each session's `cwd` sits in git, cached per working tree and kept
  // fresh by a watch on that tree's HEAD (spec
  // 2026-09-22-git-location-indicator-design).
  const git = new GitStore();
  // The editors open on this machine, per workspace, from the locks the
  // extension writes into each Claude directory's `ide/` (spec
  // 2026-09-23-ide-bridge-design). Started rather than constructed-and-used:
  // starting is what reads the directories and opens sockets, and nothing
  // about it may delay or fail a session (adr `orbital-speaks-to-the-ide-itself`).
  // Each directory's context adds its own.
  const ide = new IdeStore({});
  ide.start();
  // Line changes and the PR per working tree, read only while a window has a
  // session in it open (spec 2026-09-30-branch-pr-and-line-changes-design).
  // The settings are read per call, so a switch applies without a restart.
  const branchStatus = new BranchStatusStore({ git, settings: settingsStore });
  // Where each session works now — the last `cwd` of its transcript and of
  // its running subagents', in memory only (adr
  // a-session-has-a-home-and-a-working-tree).
  const trees = new WorkingTrees({
    transcriptPath: (id, projectDir, claudeDirId) => transcriptPath(id, projectDir, claudeDirId),
    git,
  });
  const publishCtx = (): PublishContext => ({ hub, db, registry, runner, subagents, backgroundTasks, recentTools, git, ide, branchStatus, limits, trees });
  const republish = (sessionId: string) => publishSession(publishCtx(), sessionId);
  const rowOf = (sessionId: string): SessionRow | undefined =>
    db.select(sessionColumns).from(sessions).where(eq(sessions.id, sessionId)).get();
  /**
   * The tree a session works in now: from its row, or the registry's `cwd`
   * for one not indexed yet. What its branch status is read for.
   */
  const workingDirOf = (sessionId: string): string | undefined => {
    const row = rowOf(sessionId);
    return row ? trees.workingDir(row) : registry.get(sessionId)?.cwd;
  };
  /**
   * Republishes the sessions among these whose tree, or a running subagent's,
   * moved since they were last shaped — the ones someone is looking at
   * (`wantsAmbientUpdates`); the rest catch up when a window opens them. A
   * window's branch status follows the session to its new tree.
   */
  const republishMoved = (ids: string[]): void => {
    const ctx = publishCtx();
    const watched = ids.filter((id) => wantsAmbientUpdates(ctx, id));
    if (watched.length === 0) return;
    const rows = db.select(sessionColumns).from(sessions).where(inArray(sessions.id, watched)).all() as SessionRow[];
    for (const row of rows) {
      if (!trees.moved(row, subagents.all(row.id), statusOf(ctx, row) === 'ended')) continue;
      if (hub.subscriberCount(`session:${row.id}`) > 0) {
        branchStatus.unwatchSession(row.id);
        branchStatus.watchSession(row.id, trees.workingDir(row));
      }
      republish(row.id);
    }
  };

  git.on('change', (_root: string, cwds: string[]) => republishCwds(publishCtx(), cwds));
  ide.on('change', (_root: string, cwds: string[]) => republishCwds(publishCtx(), cwds));
  branchStatus.on('change', (_root: string, cwds: string[]) => republishCwds(publishCtx(), cwds));

  // One store for both message producers, so a live image and its reloaded
  // twin land as the same file and the same ref.
  const dataDir = overrides.dataDir ?? CONFIG.dataDir;
  const imagesDir = join(dataDir, 'images');
  const images = createImageStore(imagesDir);
  const files = createFileStore(join(CONFIG.dataDir, 'files'));

  // Names a session from its own contents when someone clicks ⟳ —
  // `POST /api/sessions/:id/retitle`. See
  // `docs/decisions/session-titles-only-on-demand.md`.
  const titler = new SessionTitler({
    queryFn: overrides.titleQueryFn ?? query,
    claudeExecutablePath: claudeCli.path,
    envFor: envForSession,
    readSession: (sessionId) =>
      db
        .select({ title: sessions.title })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get(),
    applyTitle: (sessionId, title) => {
      db.update(sessions)
        .set({ title, titleSource: 'auto' })
        .where(eq(sessions.id, sessionId))
        .run();
      republish(sessionId);
    },
  });

  // Templates and the checklists sessions follow (spec
  // 2026-09-30-session-harness-design). `runner` is declared below; every
  // use of it here runs after it exists.
  /** The gate each session's harness last stood at, to republish only when it flips. */
  const harnessGates = new Map<string, HarnessGate | null>();
  const harness: HarnessService = new HarnessService({
    db,
    isEnabled: () => settingsStore.get('harness_enabled') === 'true',
    cwdOf: (sessionId) =>
      db.select({ cwd: sessions.cwd }).from(sessions).where(eq(sessions.id, sessionId)).get()?.cwd,
    decisionPending: (sessionId): boolean => runner.pendingDecision(sessionId) !== null,
    backgroundWork: (sessionId) =>
      subagents.running(sessionId).length > 0 || backgroundTasks.running(sessionId).length > 0,
    isWaiting: (sessionId): boolean => runner.status(sessionId) === 'needs_input',
    send: (sessionId, text): string | null => runner.send(sessionId, text),
    // Both read the session's work, so both run under its directory (adr
    // helper-queries-run-under-the-sessions-account).
    askWatcher: (prompt, sessionId) =>
      askWatcher(overrides.titleQueryFn ?? query, prompt, {
        claudeExecutablePath: claudeCli.path, env: envForSession(sessionId),
      }),
    askReviewer: (prompt, cwd, { model, abortController, sessionId }) =>
      askReviewer(overrides.titleQueryFn ?? query, prompt, {
        cwd, model, abortController, claudeExecutablePath: claudeCli.path, env: envForSession(sessionId),
      }),
    // The reviewer's default: the model the session asked for, else the one that ran.
    modelOf: (sessionId) => {
      const row = db.select({ model: sessions.model, resolvedModel: sessions.resolvedModel })
        .from(sessions).where(eq(sessions.id, sessionId)).get();
      return row?.model ?? row?.resolvedModel ?? null;
    },
    // The user picks the model per draft (spec 2026-10-02-harness-redesign-design § Drafting model).
    // A template is about no session: the default directory's account.
    askDrafter: (prompt, model) =>
      askOnce(overrides.titleQueryFn ?? query, prompt, {
        systemPrompt: DRAFT_SYSTEM_PROMPT, model, claudeExecutablePath: claudeCli.path,
        env: envForDir(claudeDirs.defaultId()),
      }),
    publish: (sessionId, h) => {
      hub.publish(`session:${sessionId}`, { event: 'harness', harness: h });
      // A gate waiting or being reviewed is the session's state (spec
      // 2026-10-02-harness-redesign-design § 2): republish the session when it flips.
      const gate = h ? gateOf(h) : null;
      if ((harnessGates.get(sessionId) ?? null) !== gate) {
        harnessGates.set(sessionId, gate);
        republish(sessionId);
      }
    },
    // Orbital's own messages, for a transcript open on the session; the file
    // read marks them the same way after any restart.
    publishMessage: (sessionId, message) =>
      hub.publish(`session:${sessionId}`, { event: 'harness_message', message }),
    onError: (sessionId, err, during) =>
      errors.record({
        source: 'server',
        kind: 'api_request',
        sessionId,
        message: err instanceof Error ? err.message : String(err),
        detail: err instanceof Error ? (err.stack ?? null) : null,
        context: { while: during },
      }),
  });

  // The walkthrough's narration, written by a one-shot query outside the
  // session and kept in SQLite (spec 2026-09-30-narrate-out-of-band-design).
  // Loading fails whatever the previous server left running.
  const narrator = new Narrator({
    db,
    queryFn: overrides.narrateQueryFn ?? query,
    claudeExecutablePath: claudeCli.path,
    envFor: envForSession,
    model: () => settingsStore.get('narrate_model'),
    onFinish: (sessionId) => hub.publish(`session:${sessionId}`, { event: 'walkthrough_narration' }),
    onError: (sessionId, err) =>
      errors.record({
        source: 'server',
        kind: 'api_request',
        sessionId,
        message: err instanceof Error ? err.message : String(err),
        detail: err instanceof Error ? (err.stack ?? null) : null,
        context: { while: 'narrating a walkthrough' },
      }),
  });
  narrator.load();

  /**
   * What a stopped process leaves behind — the user's End or Clear, the
   * sleep timer, or a CLI that exited on its own all arrive here, as the
   * Runner's release (`onOwnership` with `null`).
   *
   * The announcement is made here and not by the Runner, which cannot know
   * it: a stopped session reads `ended` only if a route stamped `ended_at`,
   * and `idle` otherwise (spec 2026-09-24-sessions-end-only-by-hand-design
   * § 1, § 2). By the time this runs the Runner no longer answers for the
   * session, so `statusOf` reads the row.
   */
  /**
   * A session's compaction failure stops being its current state: the next
   * turn started, or a compaction succeeded (spec
   * 2026-09-28-context-compaction-design § Failure). The rows stay — they
   * are the transcript's marks — and only `lastCompactionFailed` moves.
   * True when anything was cleared, so a caller republishes only then.
   */
  const clearCompactionFailure = (sessionId: string): boolean =>
    db.update(compactionFailures)
      .set({ clearedAt: Date.now() })
      .where(and(eq(compactionFailures.sessionId, sessionId), isNull(compactionFailures.clearedAt)))
      .run().changes > 0;

  const released = (sessionId: string) => {
    // Nothing is running in it any more — and nothing is left to observe the
    // `tool_result` that would otherwise retire its agents.
    subagents.drop(sessionId);
    // Same moment, same reasoning: nothing can join a new frame to this
    // session's buffers once its process is gone, so hanging onto them would
    // only be a leak.
    //
    // This says nothing about what any client is showing. A browser holds
    // `subagentPanel` in its own store, and neither a status change nor the
    // `remove` that may follow it necessarily moves `ui.selectedId`, which
    // is what the panel's close guard watches. Closing it is the client's job
    // (`applySessionsEvent`'s `remove` branch in `web/src/store/store.ts`); a
    // panel that outlives this drop refetches into a 404 and renders STREAM
    // LOST, which is the honest reading — the buffer really is gone by then.
    subagentTranscripts.drop(sessionId);
    // Its background tasks are not dropped — they are kept, ended — but
    // they died with the CLI process, so whatever was still running ends
    // now, without a status (spec 2026-09-28-background-tasks-design § 2
    // Ending). The republish below carries it.
    backgroundTasks.endAll(sessionId);
    // Recent tool calls are dropped — they are in-memory only and meant to
    // be live (spec 2026-10-01-map-themes-design § 5).
    recentTools.drop(sessionId);
    // One of the two moments a session's stats are written (spec
    // 2026-09-20-session-stats-design § Evaluation cadence). `liveStats`
    // is declared below, like `runner` in `publishCtx`.
    liveStats.end(sessionId);
    harness.forget(sessionId);
    // Both topics: the selected session's panel listens on `session:<id>`,
    // the map on `sessions`.
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, sessionId)).get() as
      | SessionRow
      | undefined;
    if (row) hub.publish(`session:${sessionId}`, { event: 'status', status: statusOf(publishCtx(), row) });
    republish(sessionId);
  };

  // MCP config changes run `claude mcp` itself, outside the SDK, so they need
  // an executable path even when the session CLI is the SDK's bundled one,
  // whose path `claudeCli` leaves null (spec
  // 2026-10-01-mcp-servers-in-the-session-design § Config).
  //
  // One per Claude directory, built on use: it holds nothing but the paths,
  // and reads and writes the directory's own `.claude.json` (spec
  // 2026-10-04-multiple-claude-directories-design § 4).
  const mcpCliPath = claudeCli.path ?? (claudeCli.source === 'bundled' ? sdkBundledCliPath() : null);
  const mcpFor = (claudeDirId: number): McpConfig => {
    const dir = claudeDirs.get(claudeDirId) ?? claudeDirs.get(claudeDirs.defaultId());
    return new McpConfig({
      cliPath: mcpCliPath,
      claudeJsonPath: claudeJsonPath(dir?.path ?? cliDefaultDir()),
      env: envForDir(claudeDirId),
    });
  };

  const runner = new Runner({
    hub,
    queryFn: overrides.queryFn,
    claudeExecutablePath: claudeCli.path,
    images,
    // A second route to a parked permission's verdict, never the only one:
    // with no editor running every decision is still answered from the
    // browser (spec 2026-09-23-ide-bridge-design § Talking back to the
    // editor).
    ide: ideApprovals(ide),
    subagentTranscripts,
    // Which `/mcp` rows are editable: read per call, the CLI rewrites it.
    mcpConfig: (cwd, sessionId) => mcpFor(dirOfSession(sessionId)).read(cwd),
    // Where a live row was written: the transcript's last `cwd`, the main
    // one's or the subagent's the frame came from.
    cwdOf: (sessionId, agentToolUseId) => {
      const row = rowOf(sessionId);
      if (!row) return null;
      if (agentToolUseId === null) return trees.currentCwd(row);
      const agent = subagents.all(sessionId).find((a) => a.toolUseId === agentToolUseId);
      return agent ? trees.agentCwd(row, agent) : null;
    },
    // Every start runs under its directory's login (spec
    // 2026-10-04-multiple-claude-directories-design § 3).
    envFor: envForDir,
    // Read per start, never captured: every switch and the text hold for a
    // session from its next spawn or revive (spec
    // 2026-09-30-session-instructions-design § 1). Default-on rows read
    // `!== 'false'` so an unknown key — an install from before the rows —
    // counts as on, exactly like a fresh database.
    appendix: () =>
      composeAppendix({
        tipsOn: settingsStore.get('session_instructions_tips') !== 'false',
        commentary: settingsStore.get('narrate_commentary') === 'true',
        customOn: settingsStore.get('session_instructions_custom') !== 'false',
        customText: settingsStore.get('session_instructions_custom_text'),
      }),
    onStatus: (sessionId, status) => {
      // A turn actually starting is what retires the interrupted mark — the
      // session has moved on from the turn the restart cut short. It hangs
      // off `onStatus` rather than `onOwnership`, which also reports the
      // claim a revive makes before any turn has run.
      if (status === 'working') {
        db.update(sessions).set({ interruptedAt: null }).where(eq(sessions.id, sessionId)).run();
        // The same edge retires a failed compaction as the session's state.
        if (clearCompactionFailure(sessionId)) republish(sessionId);
      }
      hub.publish('sessions', { event: 'status', sessionId, status });
    },
    // The claim that survives a kill: written on every change, cleared only
    // when the process stops. A `tsx watch` restart never reaches the clear,
    // which is how the next boot recognises a session that was cut off
    // (spec 2026-09-21-session-autoheal-design).
    onOwnership: (sessionId, status) => {
      db.update(sessions).set({ runnerStatus: status }).where(eq(sessions.id, sessionId)).run();
      if (status === null) released(sessionId);
      // The session's live feed changes hands with its owner: the Runner's
      // stream while it holds the session, a transcript tail while it does
      // not (adr: the-tail-yields-to-the-runner). `startTail`/`stopTail` are
      // declared below, like `liveStats`.
      const topic = `session:${sessionId}`;
      if (status !== null) stopTail(topic);
      else if (hub.subscriberCount(topic) > 0) startTail(topic);
    },
    onTurnUsage: (modelUsage) => recordContextWindows(settingsStore, modelUsage),
    // How full the session's context is, stored on the row and republished on
    // the `sessions` topic — the map subscribes to `session:<id>` only for the
    // selected session, so a map-wide indicator has to ride the `ApiSession`
    // snapshot (spec `context-fill-arc`). Same `republish` path as the
    // resolved model and the subagents, for the same reason: one publisher.
    //
    // An update that lands before `POST /api/sessions` has inserted the row is
    // a no-op, and `republish` finds nothing to send; the next turn's result
    // writes the number anyway.
    onContextUsed: (sessionId, usedTokens) => {
      db.update(sessions)
        .set({ contextUsedTokens: usedTokens })
        .where(eq(sessions.id, sessionId))
        .run();
      republish(sessionId);
    },
    // Records the model the CLI actually started on, then republishes so every
    // surface shows it. Reuses `republish` rather than building the REST shape
    // by hand: the subagent work widened that shape past `{ db, registry, runner }`,
    // and one publisher means one place to keep correct.
    onInit: (sessionId, model) => {
      if (!model) return;
      db.update(sessions).set({ resolvedModel: model }).where(eq(sessions.id, sessionId)).run();
      republish(sessionId);
    },
    // The one feeder. The SDK reports a task's start and end as `system`
    // messages; the tool blocks cannot, because `Agent` runs in the
    // background and its tool_result comes back at launch
    // (adr: subagent-liveness-from-sdk-task-events).
    // Both stores read every event and each keeps its own `task_type`s; the
    // background task tracker also needs the call that launched a task, which
    // only the runner saw.
    onTaskEvent: (sessionId, msg) => {
      const agentsChanged = subagents.feedTask(sessionId, msg);
      const tasksChanged = backgroundTasks.feedTask(sessionId, msg, (toolUseId) =>
        runner.launchingCall(sessionId, toolUseId),
      );
      if (agentsChanged || tasksChanged) republish(sessionId);
      // A notification can name the output file for the first time; a view
      // already open on the task starts following it then.
      if (msg.subtype === 'task_notification') startFollower(`task-output:${sessionId}:${msg.task_id}`);
    },
    // Record tool calls for the recent-tools list. Fed from tool_use blocks
    // in the main loop (not subagent frames, only the session's own).
    onToolUse: (sessionId, toolName, toolInput, at) => {
      recentTools.record(sessionId, toolName, toolInput, at);
      republish(sessionId);
    },
    // The same stores, read back: a session whose turn ended with agents or
    // background tasks still running is working, not waiting for the human
    // (fix: `a-turn-that-launched-an-agent-reads-as-needs-input`; spec
    // 2026-09-28-background-tasks-design § 2 "Working while a task runs").
    // The harness's checklist tools, for as long as the feature is on.
    sessionTools: (sessionId) => harness.tools(sessionId),
    // The step commits the harness asks for, while commit-per-step is on.
    autoAllow: (sessionId, toolName, input) => harness.allowsWithoutAsking(sessionId, toolName, input),
    hasLiveBackgroundWork: (sessionId) =>
      subagents.running(sessionId).length > 0 || backgroundTasks.running(sessionId).length > 0,
    // A launch's tool_result named the output file after its task started:
    // the task gains `hasOutput`, and a view already open on it can follow.
    onTaskOutputPath: (sessionId, toolUseId, path) => {
      if (!backgroundTasks.setOutputPath(sessionId, toolUseId, path)) return;
      const taskId = backgroundTasks.taskIdForToolUse(sessionId, toolUseId);
      if (taskId) startFollower(`task-output:${sessionId}:${taskId}`);
      republish(sessionId);
    },
    // Both edges of the main loop's turn. `status === 'needs_input'` no
    // longer means "a turn just ended" now that a turn can end into
    // `working`; and the republish is what carries `awaitingSubagents` to the
    // map, since neither edge necessarily moves the status at all.
    onTurnBoundary: (sessionId, ended) => {
      if (ended) harness.onTurnEnd(sessionId);
      // A turn the CLI started by itself is a next turn too, and it moves no
      // status for `onStatus` above to see.
      else clearCompactionFailure(sessionId);
      republish(sessionId);
    },
    // Both edges of a parked question, for the map: `pendingDecision` rides
    // the snapshot, and it is what separates NEEDS INPUT from DONE.
    onDecision: (sessionId) => republish(sessionId),
    // Usage limits: every event reads the limits again, a turn ended on the
    // limit may become a wait, and a waiting session settles to `idle`.
    onRateLimit: (sessionId) => limits.rateLimitEvent(sessionId),
    onLimitHit: (sessionId, rejected, turnError) => limits.limitHit(sessionId, rejected, turnError),
    isLimitWaiting: (sessionId) => limits.isWaiting(sessionId),
    // An approved plan left plan mode. Stored on the row, so the panel's mode
    // readout stops claiming the session is read-only and a revive resumes it
    // in the mode it was actually running in — not the one it was launched in
    // (spec 2026-09-23-permission-and-plan-decisions-design).
    onPermissionMode: (sessionId, mode) => {
      db.update(sessions).set({ permissionMode: mode }).where(eq(sessions.id, sessionId)).run();
      republish(sessionId);
    },
    // How long each permission prompt waited on the user, for the stats
    // (ADR `permission-waits-are-measured-by-the-runner-only`). No recompute
    // from here: the transcript line that closes the tool follows the answer
    // and re-indexes the session, reading this row.
    onPermissionWait: (sessionId, wait) => recordPermissionWait(db, sessionId, wait),
    // What the session said, for the harness, in the shape the transcript
    // already converts to.
    onEntries: (sessionId, entries) => {
      harness.feed(sessionId, entriesToMessages(entries));
    },
    // A session that dies on its own used to say nothing at all: `pump()`
    // logged to the server's terminal and `finish()` greyed the planet out,
    // so a crashed launch and a finished conversation looked identical from
    // the browser. Recording it here is what puts the real reason somewhere
    // the UI can read — and, because it is a row, somewhere that survives a
    // reload. The session's own settings ride along in `context`, since "what
    // was it trying to run" is the first question a failed launch raises.
    // What the session was trying to run is taken from the Runner's own
    // record of the attempt, not from the sessions row: `POST /api/sessions`
    // inserts that row only after `start()` has returned, and a spawn that
    // fails is exactly the case where the two can race. The row is read only
    // to fill in what the attempt does not carry.
    readContextUsed: (sessionId) =>
      db.select({ used: sessions.contextUsedTokens }).from(sessions).where(eq(sessions.id, sessionId)).get()
        ?.used ?? null,
    // A compaction's edges (spec 2026-09-28-context-compaction-design). The
    // live state rides the snapshot, so every edge republishes; a failure is
    // also persisted — the CLI writes nothing about it into the transcript —
    // and logged, so it can be read with the session closed.
    onCompaction: (sessionId, event) => {
      if (event.type === 'succeeded') clearCompactionFailure(sessionId);
      if (event.type === 'failed') {
        const { failure } = event;
        db.insert(compactionFailures).values({
          id: failure.id, sessionId, at: failure.at, error: failure.error,
          preTokens: failure.preTokens, trigger: failure.trigger, durationMs: failure.durationMs,
        }).run();
        const row = db
          .select({ cwd: sessions.cwd, model: sessions.model, resolvedModel: sessions.resolvedModel })
          .from(sessions).where(eq(sessions.id, sessionId)).get();
        errors.record({
          source: 'server',
          kind: 'compaction_failed',
          sessionId,
          message: failure.error ? `Compaction failed: ${failure.error}` : 'Compaction failed (no reason given)',
          context: {
            trigger: failure.trigger,
            preTokens: failure.preTokens,
            durationMs: failure.durationMs,
            model: row?.resolvedModel ?? row?.model ?? null,
            cwd: row?.cwd ?? null,
          },
        });
      }
      republish(sessionId);
    },
    onError: (sessionId, err, attempt) => {
      const row = db
        .select({
          cwd: sessions.cwd,
          permissionMode: sessions.permissionMode,
          model: sessions.model,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get();
      const context = attempt
        ? { cwd: attempt.cwd, permissionMode: attempt.permissionMode, model: attempt.model }
        : row
          ? { cwd: row.cwd, permissionMode: row.permissionMode, model: row.model }
          : null;
      errors.record({
        source: 'server',
        kind: 'session_failed',
        sessionId,
        message: err instanceof Error ? err.message : String(err),
        detail: err instanceof Error ? (err.stack ?? null) : null,
        context,
      });
    },
  });

  // Transcript path for a session, once the indexer knows which project
  // directory it belongs to. Null until then.
  // It sits under the session's own Claude directory; one no longer
  // configured reads as the default's, where its file will not be.
  const transcriptPath = (id: string, projectDir: string, claudeDirId: number): string => {
    const dir = claudeDirs.get(claudeDirId) ?? claudeDirs.get(claudeDirs.defaultId());
    return join(dir?.path ?? cliDefaultDir(), 'projects', projectDir, `${id}.jsonl`);
  };
  const transcriptPathOf = (id: string): string | null => {
    const row = db
      .select({ project_dir: sessions.projectDir, claude_dir_id: sessions.claudeDirId })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    return row ? transcriptPath(id, row.project_dir, row.claude_dir_id) : null;
  };

  /**
   * Settings → General → "Delete sessions older than" (spec
   * 2026-09-21-settings-sections-design § 4). Runs at boot and again whenever
   * the setting changes, so the confirmation the dialog shows is honoured
   * immediately rather than at the next restart.
   *
   * Order matters here: the sweep must run BEFORE `indexProjects`, because
   * the sweep is what writes the tombstones the indexer then obeys. Run the
   * other way round on a cold start, the scan would index everything first
   * and the sweep would delete rows it had just created — the same answer,
   * but after parsing every transcript on the machine for nothing.
   */
  function runRetentionSweep(): string[] {
    const now = Date.now();
    const cutoff = retentionCutoff(parseRetentionDays(settingsStore.get(RETENTION_KEY)), now);
    const swept = sweepSessions(db, cutoff, now);
    for (const id of swept) hub.publish('sessions', { event: 'remove', sessionId: id });
    return swept;
  }

  // Every rewrite of a session's rollup is announced on that session's own
  // topic, whichever cadence wrote it. The payload is the id alone: what
  // changed is a row in the database, and the client re-reads
  // `GET /api/stats/sessions/:id` for the numbers (ADR
  // `the-stats-row-reads-when-the-stats-are-written`).
  //
  // `hub.publish` is a no-op for a topic nobody is on, so a session no window
  // has open costs one map lookup per write.
  const statsWritten = (sessionId: string) =>
    hub.publish(`session:${sessionId}`, { event: 'stats', sessionId });

  // Keeps a running session's stored rollup fresh between index passes: it
  // counts turns off what the tail reads and reparses on the cadence, and
  // writes a final rollup when a session ends.
  const liveStats = new LiveSessionStats({ db, transcriptPathOf, onStats: statsWritten });

  // The live feed for a session the Runner does not own: a transcript tail
  // per subscribed `session:<id>` topic, publishing whatever a CLI appends to
  // the file. A session the Runner owns publishes off the SDK stream instead,
  // so a tail runs exactly while the topic has a subscriber AND nobody in
  // this process owns the session. Both edges hand over — the Runner
  // claiming a session (a launch or a revive) stops its tail, and the
  // Runner releasing one (its process stopping) starts a tail for whoever is
  // still watching (adr: the-tail-yields-to-the-runner).
  const tails = new Map<string, TranscriptTail>();
  const stopTail = (topic: string) => {
    tails.get(topic)?.stop();
    tails.delete(topic);
  };
  const startTail = (topic: string) => {
    if (!topic.startsWith('session:') || tails.has(topic)) return;
    const id = topic.slice('session:'.length);
    // The Runner lets go of a session before it announces the release, so on
    // that edge this already reads `undefined`.
    if (runner.status(id) !== undefined) return; // web sessions publish directly
    const transcriptPath = transcriptPathOf(id);
    if (!transcriptPath) return;
    const tail = new TranscriptTail(transcriptPath);
    tail.on('entries', (entries) => {
      liveStats.feed(id, entries);
      // Extract and record tool_use blocks from terminal sessions
      const now = Date.now();
      for (const entry of entries) {
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use') {
              const toolBlock = block as Record<string, unknown>;
              const toolName = toolBlock.name;
              const toolInput = toolBlock.input;
              if (typeof toolName === 'string') {
                recentTools.record(id, toolName, toolInput, now);
              }
            }
          }
        }
      }
      for (const msg of entriesToMessages(entries, images)) {
        hub.publish(topic, { event: 'message', message: msg });
      }
    });
    // The branch changed under what the client holds — a rewind done in the
    // terminal, or an interrupt's dangling call dropped. Nothing to append:
    // the client reads the transcript again (spec 2026-09-29-rewind-design §
    // Reading the live branch).
    tail.on('reset', () => hub.publish(topic, { event: 'transcript_reset' }));
    // Start at EOF, not byte 0: history is served over REST, and the first WS
    // subscriber replaying the entire transcript on every (re)subscribe is
    // both wasteful and duplicative of what GET /api/sessions/:id/messages
    // already returned. TranscriptTail holds back a trailing partial line, so
    // starting exactly at the current size is safe even mid-write.
    //
    // No subagent reading happens here. Scanning the transcript would cost a
    // multi-megabyte parse per session opened to answer "none running", which
    // is the only answer a transcript can give.
    let from = 0;
    try {
      from = statSync(transcriptPath).size;
    } catch {
      /* file doesn't exist yet; start at 0 */
    }
    tail.start(from);
    tails.set(topic, tail);
  };
  // A background task's output, followed while a view has it open: topic
  // `task-output:<sessionId>:<taskId>`, one file watched per topic and none
  // while nobody looks (spec 2026-09-28-background-tasks-design § 4
  // Following). Only the path the store recorded for the task is ever
  // opened. A task whose path is not known yet starts following once it is
  // (`onTaskOutputPath` above).
  const followers = new Map<string, OutputFollower>();
  const TASK_OUTPUT_PREFIX = 'task-output:';
  const stopFollower = (topic: string) => {
    followers.get(topic)?.stop();
    followers.delete(topic);
  };
  function startFollower(topic: string): void {
    if (!topic.startsWith(TASK_OUTPUT_PREFIX) || followers.has(topic)) return;
    if (hub.subscriberCount(topic) === 0) return;
    // Session ids are UUIDs, so the first colon ends the session id and the
    // task id is whatever follows it.
    const rest = topic.slice(TASK_OUTPUT_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon <= 0) return;
    const path = backgroundTasks.outputPath(rest.slice(0, colon), rest.slice(colon + 1));
    if (!path) return;
    const follower = new OutputFollower(
      path,
      (offset, text) => hub.publish(topic, { event: 'output', offset, text }),
      () => {
        hub.publish(topic, { event: 'gone' });
        followers.delete(topic);
      },
    );
    followers.set(topic, follower);
    follower.start();
  }

  hub.onFirstSubscriber((topic) => {
    // The probe runs only while someone has the limits view open.
    if (topic === LIMITS_TOPIC) limits.watch();
    startTail(topic);
    startFollower(topic);
    // An ended session nobody had open was skipped by `republishCwds`, so its
    // branch and editor selection may be stale in the browser by now.
    if (topic.startsWith('session:')) {
      const id = topic.slice('session:'.length);
      // Someone is looking at this working tree now; its branch status is
      // read and kept fresh until nobody is. A browser-minted id has no row
      // yet — `POST /api/sessions` starts the watch for that one.
      const cwd = workingDirOf(id);
      if (cwd !== undefined) branchStatus.watchSession(id, cwd);
      republish(id);
    }
  });
  hub.onLastUnsubscriber((topic) => {
    if (topic === LIMITS_TOPIC) limits.unwatch();
    stopTail(topic);
    stopFollower(topic);
    if (topic.startsWith('session:')) {
      const id = topic.slice('session:'.length);
      liveStats.drop(id);
      branchStatus.unwatchSession(id);
    }
  });

  // Initial index + re-index on transcript changes (debounced).
  //
  // The first pass reparses every transcript (+ its subagent files) to backfill
  // the stats index, which on a large ~/.claude blocks the event loop for tens
  // of seconds. Deferred to a `setImmediate` so `buildServer` returns and
  // `app.listen` binds before it starts — otherwise a fresh boot sits silent
  // and looks hung — and announced so `npm run dev` says what the pause is.
  // `clearImmediate` on close keeps it from running against a torn-down db when
  // a test builds the server and closes it before the pass fires.
  //
  // The retention sweep still runs synchronously first: it writes the
  // tombstones the deferred index pass obeys (spec
  // 2026-09-21-settings-sections-design § 4), so deferring the index cannot let
  // the scan re-create rows the sweep just removed.
  runRetentionSweep();
  console.log('orbital: backfilling the session-stats index (first pass, may take a while on a large ~/.claude)…');

  /**
   * A transcript skipped because another Claude directory owns its session
   * id — recorded once per directory, not per file, and never announced (adr
   * a-session-belongs-to-the-first-directory-that-indexed-it).
   */
  const collisionsRecorded = new Set<number>();
  const recordCollision = (dir: ClaudeDir, sessionId: string, ownerId: number) => {
    if (collisionsRecorded.has(dir.id)) return;
    collisionsRecorded.add(dir.id);
    errors.record({
      source: 'server',
      kind: 'session_id_collision',
      sessionId: null,
      message: `Skipped sessions in ${dir.name} that another Claude directory already shows`,
      context: { claudeDir: dir.path, ownerClaudeDirId: ownerId, firstSessionId: sessionId },
    });
  };

  /**
   * Everything one Claude directory runs (spec
   * 2026-10-04-multiple-claude-directories-design § 2): its transcripts
   * indexed and watched, its live CLI registry, its editor locks, and its
   * model catalog. The limits read every configured directory on their own.
   */
  const startClaudeDir = (dir: ClaudeDir): RouteClaudeDirContext => {
    const projectsDir = join(dir.path, 'projects');
    const owner: IndexOwner = {
      id: dir.id,
      isConfigured: (id) => claudeDirs.has(id),
      onCollision: (sessionId, ownerId) => recordCollision(dir, sessionId, ownerId),
    };
    // Deferred like the boot pass always was; contexts start in order, the
    // default's first, so its pass runs first and its sessions are its own.
    const backfill = setImmediate(() => indexProjects(db, projectsDir, statsWritten, owner));
    // After boot, an event indexes the transcripts it named, not the tree: the
    // full pass stats every transcript on the machine, and a working session
    // writes several times a second.
    const projectsWatcher = watchProjects(
      projectsDir,
      (batch) => {
        if (batch.all) indexProjects(db, projectsDir, statsWritten, owner);
        else indexPaths(db, projectsDir, batch.paths, statsWritten, owner);
        // The same writes are what the line-change count follows: a tool that
        // edited files, a turn that ended. Hooked here, where transcripts are
        // read — Orbital's own sessions and the terminal's alike — and not in
        // `publishSession`, which the store's own change republishes through and
        // would feed back into a recount.
        const ids = batchSessionIds(batch);
        if (ids === null) {
          branchStatus.transcriptActivityAnywhere();
          republishMoved(trees.shapedSessions());
        } else if (ids.length > 0) {
          const rows = db.select(sessionColumns).from(sessions).where(inArray(sessions.id, ids)).all() as SessionRow[];
          branchStatus.transcriptActivity(rows.map((row) => trees.workingDir(row)));
          // A line can also have moved the session to another tree.
          republishMoved(ids);
        }
      },
      // A subagent's line can move it to another tree while the parent's
      // transcript sits still.
      (ids) => republishMoved(ids),
    );
    registry.add(dir.id, new SessionRegistry(join(dir.path, 'sessions')));
    ide.addClaudeDir(dir.path);
    const models = new ModelCatalog({
      settings: settingsStore,
      queryFn: overrides.queryFn ?? (query as unknown as QueryFn),
      cwd: process.cwd(),
      claudeExecutablePath: claudeCli.path,
      catalogKey: catalogKeyFor(dir.id, FIRST_CLAUDE_DIR_ID),
      env: envForDir(dir.id),
    });
    return {
      models,
      stop: () => {
        clearImmediate(backfill);
        projectsWatcher.close();
        registry.remove(dir.id);
        ide.removeClaudeDir(dir.path);
        limits.forgetDir(dir.id);
      },
    };
  };

  // Live registry → 'sessions' topic, REST-shaped (final-review ruling).
  registry.on('upsert', (s) => {
    // A terminal took the session: the CLI there resumes the file's newest
    // leaf, which is still the old branch, so a pending rewind no longer
    // describes anything (spec 2026-09-29-rewind-design § Errors and edge
    // cases). Every window reads the transcript again.
    if (db.delete(pendingRewinds).where(eq(pendingRewinds.sessionId, s.sessionId)).run().changes > 0) {
      hub.publish(`session:${s.sessionId}`, { event: 'transcript_reset' });
    }
    publishLiveSession(publishCtx(), s);
  });
  registry.on('remove', (id) => {
    // The CLI process is gone, which is the only "ended" a terminal session
    // announces — its final rollup is written here.
    liveStats.end(id);
    hub.publish('sessions', { event: 'remove', sessionId: id });
  });

  const claudeDirs: ClaudeDirsService<RouteClaudeDirContext> = new ClaudeDirsService({
    db,
    settings: settingsStore,
    override: overrides.claudeDir ?? process.env.ORBITAL_CLAUDE_DIR,
    startContext: startClaudeDir,
    // A removed directory's sessions leave the map; their rows stay.
    onHidden: (ids) => {
      for (const id of ids) hub.publish('sessions', { event: 'remove', sessionId: id });
    },
  });
  claudeDirs.start();

  // Let go of what the previous server was still running. Nothing is resumed:
  // a session whose process died with the server reads `idle`, and the next
  // message revives it (spec 2026-09-24-sessions-end-only-by-hand-design
  // § 5). A kill never reaches the Runner's release, so the claim is still
  // on the row; clearing it is the release the kill skipped. A claim that
  // stood at `working` was cut off mid-turn, which is what `interrupted_at`
  // records — stamped first, while the flag still says so.
  const bootedAt = Date.now();
  db.update(sessions)
    .set({ interruptedAt: bootedAt })
    .where(eq(sessions.runnerStatus, 'working'))
    .run();
  db.update(sessions)
    .set({ runnerStatus: null })
    .where(isNotNull(sessions.runnerStatus))
    .run();
  // The same for a harness review the previous server was running: it died
  // with it, and its gate waits for the user (spec 2026-10-02-harness-redesign-design § 4).
  harness.recover();

  const app = Fastify();
  // Either carrier will do: the cookie `GET /api/auth` sets for the web app,
  // or a bearer for the desktop main process and the phone's `inject`.
  const authenticated = (req: FastifyRequest): boolean =>
    apiToken === undefined ||
    tokenMatches(tokenFromCookie(req.headers.cookie), apiToken) ||
    tokenMatches(tokenFromBearer(req.headers.authorization), apiToken);
  app.addHook('onRequest', async (req, reply) => {
    // I5: DNS-rebinding guard applied to every REST request.
    if (!isAllowedHost(req.headers.host)) {
      return reply.code(403).send({ error: 'host not allowed' });
    }
    // The route Fastify matched decides, not the raw path: the router decodes
    // before matching, so `/%61pi/sessions` reaches `/api/sessions` while its
    // spelling does not start with `/api`. The raw path still counts, so an
    // unmatched `/api/...` 404s behind the guard too.
    const route = req.routeOptions.url;
    const path = req.url.split('?')[0];
    const isApi = (p: string | undefined) => p !== undefined && (p === '/api' || p.startsWith('/api/'));
    const api = isApi(route) || isApi(path);
    // C2's rule on REST too: cookies are not isolated by port, so a page on
    // another local server is same-site and its fetch would carry the cookie.
    if (api && !isAllowedWsOrigin(req.headers.origin, CONFIG.port)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }
    if (!api && route !== '/ws' && path !== '/ws') return; // the public bundle and the SPA fallback
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (read && (route === '/api/auth' || route === '/api/health')) return;
    if (!authenticated(req)) return reply.code(401).send({ error: 'unauthorized' });
  });
  // How the browser gets the cookie: the link the server prints, or the
  // desktop window's first load. Under `/api` so vite's dev proxy forwards it
  // and the cookie lands on whichever host the user is actually on.
  if (apiToken !== undefined) {
    app.get<{ Querystring: { token?: string; next?: string } }>('/api/auth', (req, reply) => {
      if (!tokenMatches(req.query.token, apiToken)) return reply.code(401).send({ error: 'unauthorized' });
      return reply
        .header('set-cookie', `${API_TOKEN_COOKIE}=${apiToken}; HttpOnly; SameSite=Strict; Path=/`)
        .redirect(safeNext(req.query.next), 302);
    });
  }
  await app.register(websocket);
  // The one non-JSON body Orbital takes: a composer attachment
  // (`POST /api/sessions/:id/attachments`). The route sets its own size limit
  // per request, so nothing is configured here.
  await app.register(multipart);
  app.get(
    '/ws',
    {
      websocket: true,
      // C2: Origin verification for the WS upgrade.
      preValidation: async (req, reply) => {
        if (!isAllowedWsOrigin(req.headers.origin, CONFIG.port)) {
          return reply.code(403).send({ error: 'origin not allowed' });
        }
      },
    },
    (socket) => hub.handleSocket(socket),
  );
  // The packaged app's window loads this server's origin, so the frontend has
  // to come from here too (spec § 1). `wildcard: false` leaves unmatched GETs
  // to the not-found handler below, which is what makes the SPA's real path
  // routes (`/sandbox`, and more coming) survive a reload.
  const staticDir = overrides.staticDir ?? process.env.ORBITAL_STATIC_DIR ?? undefined;
  if (staticDir) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.raw.url?.startsWith('/api') && !req.raw.url?.startsWith('/ws')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  // The desktop app's port probe: `app === 'orbital'` is how it tells its own
  // server from any other service holding 4737, and `claudeCli.source ===
  // 'missing'` is what raises its missing-CLI dialog (spec §§ 1, 3). `static`
  // tells it whether this server has a web app to show at all: attached to a
  // dev server there is none here, and its window belongs on vite. All three
  // field names are a contract with it.
  // Without the token it answers only the first two: enough to tell Orbital
  // from another service, nothing about this machine.
  app.get('/api/health', (req) => !authenticated(req) ? { app: 'orbital', static: Boolean(staticDir) } : ({
    app: 'orbital',
    static: Boolean(staticDir),
    claudeCli: { source: claudeCli.source, path: claudeCli.path, version: claudeCodeVersion },
    // Settings → General reads these two: they are facts about how this
    // server was started, not preferences, so they ride the health payload
    // rather than becoming settings rows nothing would ever write.
    billing,
    paths: {
      claudeDirs: claudeDirs.list().map(({ id, path }) => ({ id, path })),
      dataDir,
      dbPath: overrides.dbPath ?? CONFIG.dbPath,
    },
  }));
  // The mobile remote (spec 2026-09-30-mobile-remote-design § 3). Built
  // whether or not it is enabled — `start()` is what reads the switch — so the
  // routes always have something to ask. `inject` is how a phone's REST call
  // enters: in-process, same routes, same host guard satisfied by the header.
  const remote = new RemoteService({
    db, hub, dataDir, images, imagesDir, transcriptPath, trees,
    serverVersion: process.env.ORBITAL_VERSION ?? 'dev',
    inject: async (req) => {
      const res = await app.inject(remoteInjectOptions(req, apiToken));
      return { statusCode: res.statusCode, body: res.body };
    },
    settings: settingsStore,
    allSettings: () => Object.fromEntries(db.select().from(settingsTable).all().map((r) => [r.key, r.value])),
  });
  registerRoutes(app, {
    db, registry, runner, claudeDirs, transcriptPath, hub, subagents, subagentTranscripts, backgroundTasks, recentTools, errors,
    images, imagesDir, files, titler, narrator, git, ide, branchStatus, harness, remote, trees,
    settings: settingsStore,
    mcpFor,
    limits,
    devTools: overrides.devTools ?? process.env.ORBITAL_DEV_TOOLS === '1',
    rewindStopTimeoutMs: overrides.rewindStopTimeoutMs,
    retention: {
      sweep: runRetentionSweep,
      preview: (value: string) =>
        countSweepable(db, retentionCutoff(parseRetentionDays(value), Date.now())),
    },
  });
  remote.start();
  // After the routes, which give it the path into a session: a wait that fell
  // due while the server was down fires now.
  limits.start();
  app.addHook('onClose', (_instance, done) => {
    // First, while the db is still open — and guarded, so nothing it throws
    // can skip the runner and the db below and leave close hanging.
    try {
      remote.stop();
    } catch (err) {
      console.warn(`[remote] stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    limits.dispose();
    runner.dispose();
    registry.close();
    branchStatus.close();
    git.close();
    ide.close();
    // After the registry and the editors are closed, so stopping the
    // contexts announces nothing on the way out.
    claudeDirs.close();
    for (const tail of tails.values()) tail.stop();
    for (const follower of followers.values()) follower.stop();
    backgroundTasks.dispose();
    harness.dispose();
    db.$client.close();
    done();
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apiToken = loadOrCreateApiToken(CONFIG.dataDir);
  const app = await buildServer({ apiToken });
  await app.listen({ host: '127.0.0.1', port: CONFIG.port });
  console.log(`orbital server on http://127.0.0.1:${CONFIG.port}`);
  // The link that sets the cookie: on this server when it serves the web app,
  // on vite's port in dev, where vite proxies `/api` here.
  const webOrigin = process.env.ORBITAL_STATIC_DIR
    ? `http://127.0.0.1:${CONFIG.port}`
    : `http://localhost:${DEV_WEB_PORT}`;
  console.log(`orbital: open ${webOrigin}/api/auth?token=${apiToken}`);
}
