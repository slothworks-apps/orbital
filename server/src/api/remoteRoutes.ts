import type { FastifyInstance } from 'fastify';
import type { RemoteService } from '../remote/service.js';

/** Settings → Mobile talks to these; the phone never can (they are not allowlisted). */
export function registerRemoteRoutes(app: FastifyInstance, remote: RemoteService): void {
  app.get('/api/remote', () => remote.status());

  // "Try again": a failed start does not retry on identical settings by itself.
  app.post('/api/remote/restart', () => {
    remote.settingsChanged();
    return remote.status();
  });

  app.post('/api/remote/pair', async (_req, reply) => {
    const res = await remote.startPairing();
    if ('error' in res) return reply.code(409).send(res);
    return res;
  });

  app.post('/api/remote/pair/confirm', async (req, reply) => {
    const body = (req.body ?? {}) as { accept?: unknown; phone?: unknown; code?: unknown };
    if (typeof body.accept !== 'boolean') return reply.code(400).send({ error: 'accept must be a boolean' });
    if (typeof body.phone !== 'string') return reply.code(400).send({ error: 'phone must be a string' });
    // An accept carries the code typed from the phone; a reject needs none.
    if (body.accept && typeof body.code !== 'string') return reply.code(400).send({ error: 'code must be a string' });
    // The two refusals are told apart for the dialog's sake: "nothing to
    // confirm" closes it, "a different phone" means it is showing stale data.
    const pending = remote.status().pendingPair;
    if (!pending) return reply.code(404).send({ error: 'no_pending' });
    if (pending.phone !== body.phone) return reply.code(409).send({ error: 'mismatch' });
    const res = await remote.confirmPairing(body.accept, body.phone, body.accept ? (body.code as string) : undefined);
    if ('ok' in res) return { ok: true };
    switch (res.error) {
      case 'no_pending': return reply.code(404).send(res);
      case 'code_mismatch': return reply.code(422).send(res);
      case 'code_rejected': return reply.code(409).send(res);
      case 'relay_error': return reply.code(502).send(res);
    }
  });

  app.delete('/api/remote/devices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await remote.revoke(id))) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
