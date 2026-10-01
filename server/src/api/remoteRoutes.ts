import type { FastifyInstance } from 'fastify';
import type { RemoteService } from '../remote/service.js';

/** Settings → Mobile talks to these; the phone never can (they are not allowlisted). */
export function registerRemoteRoutes(app: FastifyInstance, remote: RemoteService): void {
  app.get('/api/remote', () => remote.status());

  app.post('/api/remote/pair', async (_req, reply) => {
    const res = await remote.startPairing();
    if ('error' in res) return reply.code(409).send(res);
    return res;
  });

  app.post('/api/remote/pair/confirm', async (req, reply) => {
    const body = (req.body ?? {}) as { accept?: unknown; phone?: unknown };
    if (typeof body.accept !== 'boolean') return reply.code(400).send({ error: 'accept must be a boolean' });
    if (typeof body.phone !== 'string') return reply.code(400).send({ error: 'phone must be a string' });
    // The two refusals are told apart for the dialog's sake: "nothing to
    // confirm" closes it, "a different phone" means it is showing stale data.
    const pending = remote.status().pendingPair;
    if (!pending) return reply.code(404).send({ error: 'no_pending' });
    if (pending.phone !== body.phone) return reply.code(409).send({ error: 'mismatch' });
    if (!(await remote.confirmPairing(body.accept, body.phone))) return reply.code(502).send({ error: 'relay_error' });
    return { ok: true };
  });

  app.delete('/api/remote/devices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await remote.revoke(id))) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
