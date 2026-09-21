import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { eq } from 'drizzle-orm';
import { CONFIG } from './config.js';
import { applyLoginShellPath } from './env/loginPath.js';
import { openDb, type OrbitalDb } from './db/database.js';
import { sessionColumns, sessions, settings as settingsTable } from './db/schema.js';
import { indexProjects } from './indexer/indexer.js';
import { SessionRegistry, type LiveSession } from './watcher/registry.js';
import { TranscriptTail } from './watcher/tail.js';
import { Hub } from './api/hub.js';
import { Runner, parseIdleTimeoutMs, type QueryFn } from './runner/runner.js';
import { resolveClaudeCodeVersion } from './runner/version.js';
import { claudeCliVersion, resolveClaudeCli, sdkBundledCliAvailable } from './runner/claudeCli.js';
import { registerRoutes } from './api/routes.js';
import { toApiSession, type ShapeContext } from './api/shape.js';
import { entriesToMessages } from './transcript/parser.js';
import { SubagentStore } from './transcript/subagents.js';
import { SessionTitler, type TitleQueryFn } from './titler/titler.js';
import { ModelCatalog } from './models/catalog.js';
import { ErrorLog } from './errors/log.js';
import { createImageStore } from './images/store.js';
import type { SessionRow } from './types.js';
import chokidar from 'chokidar';

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
    : {
        id: live.sessionId, cwd: live.cwd, title: live.name, firstAt: null,
        lastAt: live.updatedAt, messageCount: 0, source: 'terminal' as const,
        permissionMode: null, parentId: null, tagIds: [], status: live.status,
        subagents: ctx.subagents.get(live.sessionId),
      };
  ctx.hub.publish('sessions', { event: 'upsert', session });
}

/** What it takes to put a session on the `sessions` topic. */
export type PublishContext = ShapeContext & { hub: Hub };

/**
 * Republishes one session because something about it changed that lives
 * outside its DB row — today, its set of running subagents. Subagents ride
 * along in the session shape rather than on a topic of their own, so the map
 * sees them for every session (not only the selected one) and a page reload
 * gets them from `GET /api/sessions` like everything else.
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
    `http://127.0.0.1:5173`,
    `http://localhost:5173`,
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
  claudeDir?: string;
  queryFn?: QueryFn;
  /** The titler's one-shot call. Its own seam: it sends a whole prompt, not a stream. */
  titleQueryFn?: TitleQueryFn;
} = {}): Promise<FastifyInstance> {
  // Web sessions must bill the user's Claude subscription (CLI OAuth). The
  // spawned CLI prefers ANTHROPIC_API_KEY over OAuth when present, so strip
  // it unless the operator explicitly opts into API-key billing.
  if (process.env.ORBITAL_USE_API_KEY !== '1') delete process.env.ANTHROPIC_API_KEY;
  // The other half of the environment this server depends on: launched from
  // Finder it inherits `/usr/bin:/bin:/usr/sbin:/sbin`, where neither `claude`
  // nor the git/npm a session shells out to can be found. Gated, so only the
  // packaged app pays for the login-shell spawn (spec § 3).
  await applyLoginShellPath();

  const claudeDir = overrides.claudeDir ?? CONFIG.claudeDir;
  const projectsDir = join(claudeDir, 'projects');
  const sessionsDir = join(claudeDir, 'sessions');
  // `ORBITAL_MIGRATIONS_DIR` is how the packaged app points at its unpacked
  // `drizzle/` resources; unset everywhere else, where the default is right.
  const db = openDb(overrides.dbPath ?? CONFIG.dbPath, process.env.ORBITAL_MIGRATIONS_DIR || undefined);
  const hub = new Hub();
  // One log for both sides of the wire; it publishes its own changes on the
  // `errors` topic, so it needs the hub and nothing else.
  const errors = new ErrorLog({ db, hub });
  const registry = new SessionRegistry(sessionsDir);
  // Boot-time seed only — `PATCH /api/settings` pushes later changes straight
  // into the Runner (`setIdleTimeoutMs`), so this value never goes stale.
  const idleTimeoutMs = parseIdleTimeoutMs(
    db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, 'ended_after_idle_minutes'))
      .get()?.value,
  );

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

  const models = new ModelCatalog({
    settings: settingsStore,
    queryFn: overrides.queryFn ?? (query as unknown as QueryFn),
    cwd: process.cwd(),
  });

  // Running subagents, keyed by session. Read back out through
  // `toApiSession`, so a change means "republish the session".
  //
  // Only the runner ever feeds this, from the SDK's task events, i.e. only
  // orbital's own sessions have subagents. Neither a transcript nor the tool
  // blocks can answer the question: an `Agent` runs in the background and its
  // tool_result comes back at launch. See
  // `docs/domains/subagents-in-transcripts.md` and
  // `docs/decisions/subagent-liveness-from-sdk-task-events.md`.
  const subagents = new SubagentStore();
  // Built on call, not up front: the runner it names is constructed below and
  // is itself one of the things that asks for a republish.
  const publishCtx = (): PublishContext => ({ hub, db, registry, runner, subagents });
  const republish = (sessionId: string) => publishSession(publishCtx(), sessionId);

  // One store for both message producers, so a live image and its reloaded
  // twin land as the same file and the same ref.
  const imagesDir = join(CONFIG.dataDir, 'images');
  const images = createImageStore(imagesDir);

  // Names a session from its own contents while it runs. Only web sessions
  // reach it, because only they come through the Runner at all — a terminal
  // session's transcript is read, never owned. See
  // `docs/superpowers/specs/2026-09-18-auto-title-design.md`.
  const titler = new SessionTitler({
    queryFn: (overrides.titleQueryFn ?? query) as unknown as TitleQueryFn,
    readSession: (sessionId) =>
      db
        .select({ title: sessions.title, titleSource: sessions.titleSource })
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
    // Read per call, never captured: a value read once at boot ignores the
    // switch until a restart, which `ended_after_idle_minutes` already taught.
    isEnabled: () => settingsStore.get('auto_title_sessions') === 'true',
    onError: (sessionId, err) =>
      errors.record({
        source: 'server',
        kind: 'api_request',
        sessionId,
        message: err instanceof Error ? err.message : String(err),
        detail: err instanceof Error ? (err.stack ?? null) : null,
        context: { while: 'generating a session title' },
      }),
  });

  const runner = new Runner({
    hub,
    queryFn: overrides.queryFn,
    idleTimeoutMs,
    claudeExecutablePath: claudeCli.path,
    images,
    onStatus: (sessionId, status) => {
      // An ended session has nothing running in it — and nothing left to
      // observe the `tool_result` that would otherwise retire its agents.
      if (status === 'ended') subagents.drop(sessionId);
      // `needs_input` is how `pump()` spells "a turn just ended", and it is
      // the only hook that carries the session id at that moment
      // (`onTurnUsage` fires alongside it but knows only the usage).
      if (status === 'ended') titler.forget(sessionId);
      else if (status === 'needs_input') void titler.considerTurnEnd(sessionId);
      hub.publish('sessions', { event: 'status', sessionId, status });
    },
    onTurnUsage: (modelUsage) => models.recordContextWindows(modelUsage),
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
    onTaskEvent: (sessionId, msg) => {
      if (subagents.feedTask(sessionId, msg)) republish(sessionId);
    },
    // What the session said, for the titler, in the shape the transcript
    // already converts to.
    onEntries: (sessionId, entries) => {
      titler.feed(sessionId, entriesToMessages(entries));
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
  const transcriptPathOf = (id: string): string | null => {
    const row = db
      .select({ project_dir: sessions.projectDir })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get() as { project_dir: string } | undefined;
    return row ? join(projectsDir, row.project_dir, `${id}.jsonl`) : null;
  };

  // Initial index + re-index on transcript changes (debounced).
  indexProjects(db, projectsDir);
  const projectsWatcher = chokidar.watch(projectsDir, { ignoreInitial: true, depth: 2 });
  let indexTimer: ReturnType<typeof setTimeout> | null = null;
  projectsWatcher.on('all', () => {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(() => indexProjects(db, projectsDir), 500);
  });

  // Live registry → 'sessions' topic, REST-shaped (final-review ruling).
  registry.on('upsert', (s) => publishLiveSession(publishCtx(), s));
  registry.on('remove', (id) => hub.publish('sessions', { event: 'remove', sessionId: id }));
  registry.scan();
  registry.watch();

  // On-demand transcript tails per subscribed session topic.
  const tails = new Map<string, TranscriptTail>();
  hub.onFirstSubscriber((topic) => {
    if (!topic.startsWith('session:')) return;
    const id = topic.slice('session:'.length);
    if (runner.active().includes(id)) return; // web sessions publish directly
    const transcriptPath = transcriptPathOf(id);
    if (!transcriptPath) return;
    const tail = new TranscriptTail(transcriptPath);
    tail.on('entries', (entries) => {
      for (const msg of entriesToMessages(entries, images)) {
        hub.publish(topic, { event: 'message', message: msg });
      }
    });
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
  });
  hub.onLastUnsubscriber((topic) => {
    tails.get(topic)?.stop();
    tails.delete(topic);
  });

  const app = Fastify();
  // I5: DNS-rebinding guard applied to every REST request.
  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host)) {
      return reply.code(403).send({ error: 'host not allowed' });
    }
  });
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
  registerRoutes(app, {
    db, registry, runner, projectsDir, claudeDir, hub, models, subagents, errors,
    images, imagesDir,
    settings: settingsStore,
  });
  app.addHook('onClose', async () => {
    runner.dispose();
    await registry.close();
    await projectsWatcher.close();
    for (const tail of tails.values()) tail.stop();
    db.$client.close();
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await buildServer();
  await app.listen({ host: '127.0.0.1', port: CONFIG.port });
  console.log(`orbital server on http://127.0.0.1:${CONFIG.port}`);
}
