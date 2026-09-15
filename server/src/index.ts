import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { CONFIG } from './config.js';
import { openDb } from './db/database.js';
import { indexProjects } from './indexer/indexer.js';
import { SessionRegistry } from './watcher/registry.js';
import { TranscriptTail } from './watcher/tail.js';
import { Hub } from './api/hub.js';
import { Runner, type QueryFn } from './runner/runner.js';
import { registerRoutes } from './api/routes.js';
import { entriesToMessages } from './transcript/parser.js';
import { SubagentTracker } from './transcript/subagents.js';
import chokidar from 'chokidar';

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
  dbPath?: string; claudeDir?: string; queryFn?: QueryFn;
} = {}): Promise<FastifyInstance> {
  // Web sessions must bill the user's Claude subscription (CLI OAuth). The
  // spawned CLI prefers ANTHROPIC_API_KEY over OAuth when present, so strip
  // it unless the operator explicitly opts into API-key billing.
  if (process.env.ORBITAL_USE_API_KEY !== '1') delete process.env.ANTHROPIC_API_KEY;

  const claudeDir = overrides.claudeDir ?? CONFIG.claudeDir;
  const projectsDir = join(claudeDir, 'projects');
  const sessionsDir = join(claudeDir, 'sessions');
  const db = openDb(overrides.dbPath ?? CONFIG.dbPath);
  const hub = new Hub();
  const registry = new SessionRegistry(sessionsDir);
  const idleMinutes = Number(
    (db.prepare(`SELECT value FROM settings WHERE key='ended_after_idle_minutes'`).get() as any)
      ?.value ?? 30,
  );
  const runner = new Runner({
    hub,
    queryFn: overrides.queryFn,
    idleTimeoutMs: idleMinutes * 60_000,
    onStatus: (sessionId, status) => hub.publish('sessions', { event: 'status', sessionId, status }),
  });

  // Initial index + re-index on transcript changes (debounced).
  indexProjects(db, projectsDir);
  const projectsWatcher = chokidar.watch(projectsDir, { ignoreInitial: true, depth: 2 });
  let indexTimer: ReturnType<typeof setTimeout> | null = null;
  projectsWatcher.on('all', () => {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(() => indexProjects(db, projectsDir), 500);
  });

  // Live registry → 'sessions' topic.
  registry.on('upsert', (s) =>
    hub.publish('sessions', { event: 'upsert', session: { ...s, source: 'terminal' } }),
  );
  registry.on('remove', (id) => hub.publish('sessions', { event: 'remove', sessionId: id }));
  registry.scan();
  registry.watch();

  // On-demand transcript tails per subscribed session topic.
  const tails = new Map<string, TranscriptTail>();
  hub.onFirstSubscriber((topic) => {
    if (!topic.startsWith('session:')) return;
    const id = topic.slice('session:'.length);
    if (runner.active().includes(id)) return; // web sessions publish directly
    const row = db.prepare(`SELECT project_dir FROM sessions WHERE id=?`).get(id) as
      | { project_dir: string } | undefined;
    if (!row) return;
    const transcriptPath = join(projectsDir, row.project_dir, `${id}.jsonl`);
    const tail = new TranscriptTail(transcriptPath);
    const subagents = new SubagentTracker();
    tail.on('entries', (entries) => {
      for (const msg of entriesToMessages(entries)) {
        hub.publish(topic, { event: 'message', message: msg });
      }
      for (const agent of subagents.feed(entries)) {
        hub.publish(topic, { event: 'subagent', subagent: agent });
      }
    });
    // Start at EOF, not byte 0: history is served over REST, and the first WS
    // subscriber replaying the entire transcript on every (re)subscribe is
    // both wasteful and duplicative of what GET /api/sessions/:id/messages
    // already returned. TranscriptTail holds back a trailing partial line, so
    // starting exactly at the current size is safe even mid-write.
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
    db, registry, runner, projectsDir, hub,
    settings: {
      get: (k) =>
        (db.prepare(`SELECT value FROM settings WHERE key=?`).get(k) as any)?.value ?? '',
      set: (k, v) =>
        db.prepare(
          `INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        ).run(k, v),
    },
  });
  app.addHook('onClose', async () => {
    await registry.close();
    await projectsWatcher.close();
    for (const tail of tails.values()) tail.stop();
    db.close();
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await buildServer();
  await app.listen({ host: '127.0.0.1', port: CONFIG.port });
  console.log(`orbital server on http://127.0.0.1:${CONFIG.port}`);
}
