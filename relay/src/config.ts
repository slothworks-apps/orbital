import { join } from 'node:path';

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
};
