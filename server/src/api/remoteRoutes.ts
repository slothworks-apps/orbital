import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Presence } from '../remote/presence.js';
import type { RemoteService, RemoveResult } from '../remote/service.js';

/** Settings → Mobile and the desktop app talk to these; the phone never can (they are not allowlisted). */
export function registerRemoteRoutes(app: FastifyInstance, remote: RemoteService, presence?: Presence): void {
  app.get('/api/remote', () => remote.status());

  // The desktop app's heartbeat while the user is at the Mac (spec
  // 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design § 1).
  app.put('/api/presence', (req, reply) => {
    const body = (req.body ?? {}) as { atMac?: unknown };
    if (typeof body.atMac !== 'boolean') return reply.code(400).send({ error: 'atMac must be a boolean' });
    presence?.report(body.atMac);
    return reply.code(204).send();
  });

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

  // This server joins another device by its code (spec 2026-10-16-device-group-design § 3).
  app.post('/api/remote/join', async (req, reply) => {
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== 'string') return reply.code(400).send({ error: 'code must be a string' });
    const res = await remote.join(code);
    if ('error' in res) return reply.code(res.error === 'bad_code' ? 400 : 409).send(res);
    return res;
  });

  // Stops waiting for the device being joined; the relay's request expires with the code.
  app.delete('/api/remote/join', (_req, reply) => {
    if (!remote.cancelJoin()) return reply.code(404).send({ error: 'not_joining' });
    return { ok: true };
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
      case 'group_full': return reply.code(409).send(res);
      case 'relay_error': return reply.code(502).send(res);
    }
  });

  // This device's own id is leaving the group, refused as `leave` is.
  app.delete('/api/remote/devices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return removed(reply, await remote.remove(id));
  });

  // This device leaves its group (spec 2026-10-16-device-group-design § 4).
  app.post('/api/remote/leave', async (_req, reply) => removed(reply, await remote.leave()));
}

/** A removal's answer: 404 for no such device, 409 for leaving while offline, 500 for a roster that could not be written. */
function removed(reply: FastifyReply, res: RemoveResult) {
  if (!('error' in res)) return res;
  return reply.code(res.error === 'not_found' ? 404 : res.error === 'offline' ? 409 : 500).send(res);
}
