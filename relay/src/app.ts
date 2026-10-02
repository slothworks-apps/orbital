import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { MAX_FRAME_BYTES } from '@orbital/shared/remote/frame';
import { RELAY_PING_INTERVAL_MS } from '@orbital/shared/remote/relayApi';
import { Connections, OfflineQueue } from './connections.js';
import { handleSocket, type WakeHook, type WsContext } from './ws.js';
import { registerPairingRoutes } from './pairing.js';
import { LogPushSender, WakeTracker, wakeHook, type PushSender } from './push.js';
import type { RelayStore } from './store.js';

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
};

declare module 'fastify' {
  interface FastifyInstance {
    relay: WsContext;
  }
}

export async function buildRelay(opts: RelayOptions): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: opts.trustProxy ?? false });
  const tracker = new WakeTracker();
  const ctx: WsContext = {
    store: opts.store,
    connections: new Connections(),
    queue: new OfflineQueue(),
    tracker,
    onWake: opts.onWake ?? wakeHook(opts.store, tracker, opts.push ?? new LogPushSender()),
    now: opts.now ?? Date.now,
    pingIntervalMs: opts.pingIntervalMs ?? RELAY_PING_INTERVAL_MS,
  };
  app.decorate('relay', ctx);
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
  app.get('/ws', { websocket: true }, (socket, req) => {
    // `?mac=` names the Mac the device is anchored to; `paired=1` says the
    // device believes it is paired with it, and asks to be told if it is not.
    const q = req.query as { mac?: string; paired?: string };
    handleSocket(socket, ctx, q.paired === '1' && typeof q.mac === 'string' ? q.mac : null);
  });
  app.get('/health', () => ({ app: 'orbital-relay' }));
  registerPairingRoutes(app, ctx);
  app.addHook('onClose', async () => { await opts.store.close(); });
  return app;
}
