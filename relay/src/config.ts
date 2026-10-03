import { join } from 'node:path';

/**
 * `RELAY_SECRET` trimmed to `null` when unset or blank. Trimmed because the
 * Mac trims its own `remote_relay_secret` setting before sending it — an
 * untrimmed env value (a trailing newline from how a deploy sets it) could
 * never match.
 */
export function readSecret(env: NodeJS.ProcessEnv): string | null {
  return (env.RELAY_SECRET ?? '').trim() || null;
}

/** Everything the relay reads from its environment, in one place. */
export const CONFIG = {
  port: Number(process.env.RELAY_PORT ?? 4840),
  dataDir: process.env.RELAY_DATA_DIR ?? join(process.cwd(), 'data'),
  /** A Firebase service-account JSON. Absent means pushes are logged, not sent. */
  fcmServiceAccountPath: process.env.RELAY_FCM_SERVICE_ACCOUNT ?? null,
  /** `postgres://…` for a real deployment. Absent means SQLite under `dataDir` — a laptop, or tests. */
  databaseUrl: process.env.RELAY_DATABASE_URL ?? null,
  /** `1` behind a reverse proxy, so the pairing rate limit keys on the client's IP rather than the proxy's. */
  trustProxy: process.env.RELAY_TRUST_PROXY === '1',
  /**
   * The shared secret every device presents on auth and in every pairing
   * route (ADR the-relay-takes-a-shared-secret). Unset or empty means open.
   */
  secret: readSecret(process.env),
};
