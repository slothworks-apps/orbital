import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { MAX_FRAME_BYTES } from '@orbital/shared/remote/frame';
import { RELAY_PING_INTERVAL_MS } from '@orbital/shared/remote/relayApi';
import { RELAY_VERSION_HEADER } from '@orbital/shared/remote/version';
import { Connections, OfflineQueue } from './connections.js';
import { RateLimiter } from './rateLimit.js';
import { handleSocket, type WakeHook, type WsContext } from './ws.js';
import { registerPairingRoutes } from './pairing.js';
import { LogPushSender, WakeTracker, wakeHook, type PushSender } from './push.js';
import type { RelayStore } from './store.js';
import { RELAY_VERSION } from './version.js';

export { MAX_BUFFERED_BYTES, OFFLINE_QUEUE_MAX } from './connections.js';

export type RelayOptions = {
  store: RelayStore;
  onWake?: WakeHook;
  push?: PushSender;
  now?: () => number;
  pingIntervalMs?: number;
  /**
   * Take the client IP from `X-Forwarded-For`. Only behind a proxy that sets
   * it (Dokploy's Traefik); otherwise every client could pick its own IP and
   * dodge the pairing rate limit.
   */
  trustProxy?: boolean;
  /** `RELAY_SECRET`: required on auth and pairing when set; absent or null leaves the relay open. */
  secret?: string | null;
};

declare module 'fastify' {
  interface FastifyInstance {
    relay: WsContext;
  }
}

export async function buildRelay(opts: RelayOptions): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: opts.trustProxy ?? false });
  const tracker = new WakeTracker();
  const now = opts.now ?? Date.now;
  const ctx: WsContext = {
    store: opts.store,
    connections: new Connections(),
    queue: new OfflineQueue(),
    tracker,
    onWake: opts.onWake ?? wakeHook(opts.store, tracker, opts.push ?? new LogPushSender()),
    now,
    pingIntervalMs: opts.pingIntervalMs ?? RELAY_PING_INTERVAL_MS,
    secret: opts.secret || null,
    limiter: new RateLimiter(now),
  };
  app.decorate('relay', ctx);
  // Every HTTP answer says which relay gave it, errors included: a device
  // that needs a newer relay learns it from whatever it asked.
  app.addHook('onSend', async (_req, reply, payload) => {
    void reply.header(RELAY_VERSION_HEADER, RELAY_VERSION);
    return payload;
  });
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
  app.get('/ws', { websocket: true }, (socket, req) => {
    // `?mac=` names the Mac the device is anchored to; `paired=1` says the
    // device believes it is paired with it, and asks to be told if it is not.
    const q = req.query as { mac?: string; paired?: string };
    handleSocket(socket, ctx, q.paired === '1' && typeof q.mac === 'string' ? q.mac : null, req.ip);
  });
  app.get('/health', () => ({ app: 'orbital-relay' }));
  registerPairingRoutes(app, ctx);
  app.addHook('onClose', async () => { await opts.store.close(); });
  return app;
}
