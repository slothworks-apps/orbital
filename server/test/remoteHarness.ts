/**
 * A real relay and a real Orbital server with the remote switched on and
 * pointed at it — the harness every end-to-end remote test shares. The phone
 * side is the caller's: `FakePhone` where a test needs a phone that
 * misbehaves, `RemoteClient` for everything a real phone does.
 */
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildRelay } from '@orbital/relay/app';
import { openRelayStore } from '@orbital/relay/store';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { settings as settingsTable } from '../src/db/schema.js';
import { makeTmpDir } from './tmp.js';

export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

export async function until(cond: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export type InjectMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type MacAndRelay = {
  relayUrl: string;
  app: FastifyInstance;
  /** The server's data dir: `index.db`, the identity, `images/`, and `claude/` as its `~/.claude`. */
  dir: string;
  api: (method: InjectMethod, url: string, payload?: unknown) => Promise<{ statusCode: number; json(): any }>;
};

/**
 * Online before it resolves. `settings` and `beforeBoot` run before
 * `buildServer`, which is when the remote reads its settings and the indexer
 * first scans `claude/projects`.
 */
export async function startMacAndRelay(
  closers: (() => unknown)[],
  opts: { settings?: [string, string][]; beforeBoot?: (dir: string) => void; apiToken?: string } = {},
): Promise<MacAndRelay> {
  const relay = await buildRelay({ store: await openRelayStore(':memory:') });
  const relayUrl = await listen(relay);
  closers.push(() => relay.close());

  const dir = makeTmpDir('e2e');
  const dbPath = join(dir, 'index.db');
  const db = openDb(dbPath);
  const seeded: [string, string][] = [
    ['remote_enabled', 'true'], ['remote_relay_url', relayUrl], ['remote_mac_name', 'studio'], ...(opts.settings ?? []),
  ];
  for (const [key, value] of seeded) {
    db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value } }).run();
  }
  // Seeded before boot so the remote starts enabled; the server opens its own handle.
  db.$client.close();
  opts.beforeBoot?.(dir);
  const app = await buildServer({ dbPath, claudeDir: join(dir, 'claude'), dataDir: dir, apiToken: opts.apiToken });
  closers.push(() => app.close());
  const headers = opts.apiToken === undefined ? undefined : { authorization: `Bearer ${opts.apiToken}` };
  const api: MacAndRelay['api'] = (method, url, payload) => app.inject({ method, url, payload: payload as any, headers });

  await until(async () => (await api('GET', '/api/remote')).json().relay === 'online');
  return { relayUrl, app, dir, api };
}
