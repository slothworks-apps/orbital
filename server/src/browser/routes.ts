import type { FastifyInstance } from 'fastify';
import type { BrowserBridge } from './bridge.js';
import type { BrowserDropReason, BrowserOutcome } from './protocol.js';

const DROP_REASONS: ReadonlySet<string> = new Set<BrowserDropReason>(['no-session', 'no-window', 'foreign', 'composer-full']);

/** The outcome a window posts, or null when it is malformed. */
export function parseOutcome(body: unknown): BrowserOutcome | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.eventId !== 'string' || b.eventId === '' || typeof b.delivered !== 'boolean') return null;
  if (b.sessionId !== undefined && typeof b.sessionId !== 'string') return null;
  if (b.reason !== undefined && (typeof b.reason !== 'string' || !DROP_REASONS.has(b.reason))) return null;
  return {
    eventId: b.eventId,
    delivered: b.delivered,
    ...(typeof b.sessionId === 'string' ? { sessionId: b.sessionId } : {}),
    ...(typeof b.reason === 'string' ? { reason: b.reason as BrowserDropReason } : {}),
  };
}

/**
 * Settings' half of the bridge and the windows' answer about an event, all
 * behind the API token. None of them is on the phone's allowlist: the phone
 * is left out on purpose (spec § The phone).
 */
export function registerBrowserRoutes(app: FastifyInstance, bridge: BrowserBridge): void {
  app.get('/api/browser', () => bridge.status());

  app.post('/api/browser/pairing-code', (_req, reply) => {
    const code = bridge.newPairingCode();
    if (!code) return reply.code(409).send({ error: 'disabled' });
    return code;
  });

  app.delete('/api/browser/pairings/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    if (!bridge.revoke(id)) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.post('/api/browser/outcome', (req, reply) => {
    const outcome = parseOutcome(req.body);
    if (!outcome) return reply.code(400).send({ error: 'invalid_outcome' });
    bridge.outcome(outcome);
    return reply.code(204).send();
  });
}
