import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    const tail = new TranscriptTail(join(projectsDir, row.project_dir, `${id}.jsonl`));
    const subagents = new SubagentTracker();
    tail.on('entries', (entries) => {
      for (const msg of entriesToMessages(entries)) {
        hub.publish(topic, { event: 'message', message: msg });
      }
      for (const agent of subagents.feed(entries)) {
        hub.publish(topic, { event: 'subagent', subagent: agent });
      }
    });
    tail.start();
    tails.set(topic, tail);
  });
  hub.onLastUnsubscriber((topic) => {
    tails.get(topic)?.stop();
    tails.delete(topic);
  });

  const app = Fastify();
  await app.register(websocket);
  app.get('/ws', { websocket: true }, (socket) => hub.handleSocket(socket));
  registerRoutes(app, {
    db, registry, runner, projectsDir,
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
