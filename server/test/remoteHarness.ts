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
import type { RemoteService } from '../src/remote/service.js';
import type { FederationService } from '../src/federation/service.js';
import { openDb } from '../src/db/database.js';
import { settings as settingsTable } from '../src/db/schema.js';
import { fingerprint, publicKeyOf } from '@orbital/shared/remote/keys';
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

export type InjectMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type MacAndRelay = {
  relayUrl: string;
  app: FastifyInstance;
  /** The server's data dir: `index.db`, the identity, `images/`, and `claude/` as its `~/.claude`. */
  dir: string;
  api: (method: InjectMethod, url: string, payload?: unknown) => Promise<{ statusCode: number; json(): any }>;
  /** The server's remote service, for what no route shows (a device's channel). */
  remote: RemoteService;
  /** The server's federation: the other members' sessions in its hub. */
  federation: FederationService;
};

/**
 * Online before it resolves. `settings` and `beforeBoot` run before
 * `buildServer`, which is when the remote reads its settings and the indexer
 * first scans `claude/projects`. With `relayUrl` no relay is built: the
 * server joins the one already running there, as a second Mac would. With
 * `dir` the server boots on that data dir, as the same Mac restarted.
 */
export async function startMacAndRelay(
  closers: (() => unknown)[],
  opts: {
    settings?: [string, string][]; beforeBoot?: (dir: string) => void; apiToken?: string;
    relayUrl?: string; name?: string; dir?: string;
  } = {},
): Promise<MacAndRelay> {
  let relayUrl = opts.relayUrl;
  if (relayUrl === undefined) {
    const relay = await buildRelay({ store: await openRelayStore(':memory:') });
    relayUrl = await listen(relay);
    closers.push(() => relay.close());
  }

  const dir = opts.dir ?? makeTmpDir('e2e');
  const dbPath = join(dir, 'index.db');
  const db = openDb(dbPath);
  const seeded: [string, string][] = [
    ['remote_enabled', 'true'], ['remote_relay_url', relayUrl], ['remote_mac_name', opts.name ?? 'studio'], ...(opts.settings ?? []),
  ];
  for (const [key, value] of seeded) {
    db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value } }).run();
  }
  // Seeded before boot so the remote starts enabled; the server opens its own handle.
  db.$client.close();
  opts.beforeBoot?.(dir);
  let remote: RemoteService | null = null;
  let federation: FederationService | null = null;
  const app = await buildServer({
    dbPath, claudeDir: join(dir, 'claude'), dataDir: dir, apiToken: opts.apiToken, exposeRemote: (r) => { remote = r; },
    exposeFederation: (f) => { federation = f; },
  });
  closers.push(() => app.close());
  const headers = opts.apiToken === undefined ? undefined : { authorization: `Bearer ${opts.apiToken}` };
  const api: MacAndRelay['api'] = (method, url, payload) => app.inject({ method, url, payload: payload as any, headers });

  await until(async () => (await api('GET', '/api/remote')).json().relay === 'online');
  return { relayUrl, app, dir, api, remote: remote!, federation: federation! };
}

/** The code a phone shows for its pairing request: what the user types on the Mac. */
export function pairingCode(macId: string, phoneKey: Uint8Array): string {
  return fingerprint(publicKeyOf(macId)!, phoneKey);
}

/** A six-character code that is not `code`. */
export function wrongCode(code: string): string {
  return (code[0] === 'A' ? 'B' : 'A') + code.slice(1);
}
