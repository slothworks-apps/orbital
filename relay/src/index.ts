import { join } from 'node:path';
import { CONFIG } from './config.js';
import { buildRelay } from './app.js';
import { FcmPushSender, LogPushSender, loadServiceAccount } from './push.js';
import { openRelayStore } from './store.js';

const store = await openRelayStore(CONFIG.databaseUrl ?? join(CONFIG.dataDir, 'relay.db'));
const push = CONFIG.fcmServiceAccountPath
  ? new FcmPushSender(loadServiceAccount(CONFIG.fcmServiceAccountPath))
  : new LogPushSender();
const app = await buildRelay({ store, push, trustProxy: CONFIG.trustProxy, secret: CONFIG.secret });
await app.listen({ port: CONFIG.port, host: '0.0.0.0' });
console.log(`orbital relay listening on ${CONFIG.port}`);
