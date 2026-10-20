import type { FastifyInstance } from 'fastify';
import { parseUpdateStartBody, type UpdateAsker } from '@orbital/shared/remote/serverUpdate';
import { DEVICE_HEADER } from '../remote/inject.js';
import type { UpdateService } from '../update/service.js';

/** What the routes ask of the group to name the member that asked. */
export type AskerDirectory = {
  /** This device's id; null when it never had one. */
  selfId(): string | null;
  /** The name every member sees for this device. */
  selfName(): string;
  /** The name a member goes by here; null for a device this one does not know. */
  nameOf(id: string): string | null;
};

/**
 * Who asked for an update: the member whose channel carried the request
 * (`DEVICE_HEADER`, set by the channel, never by the caller's body), or this
 * device for a request made on it — its web or the `orbital` CLI. A peer
 * this device has no name for goes by the start of its id, as the roster
 * names an undescribed member. Null for a local request on a device that has
 * never had an id.
 */
export function updateAsker(device: string | string[] | undefined, dir: AskerDirectory): UpdateAsker | null {
  if (typeof device === 'string' && device !== '') return { id: device, name: dir.nameOf(device) ?? device.slice(0, 8) };
  const self = dir.selfId();
  return self === null ? null : { id: self, name: dir.selfName() };
}

/**
 * Updating this server from any member of the group, the phone included,
 * and from the local `orbital` CLI (spec 2026-10-19-headless-server-design
 * § Updating from the group). Both routes are on the members' allowlist;
 * any member may call them, there is no primary check.
 *
 * `POST` reads nothing from the request but who sent it (`updateAsker`) and
 * when to install (`parseUpdateStartBody`: an absent body, or `{ when:
 * 'now' | 'idle' }` and no other field — anything else is 400 `bad_request`
 * and starts nothing); no query, no version, no package. 202 with the state
 * when the update starts or waits; 409 `no_update`, `updating` or
 * `not_set_up`; 501 `not_packaged`.
 *
 * `DELETE` ends a wait for the sessions (`UpdateService.cancel`); it reads
 * nothing from the request. 200 with the state; 409 `not_waiting`.
 */
export function registerServerUpdateRoutes(app: FastifyInstance, updates: UpdateService, dir: AskerDirectory): void {
  app.get('/api/server/update', () => updates.state());

  app.post('/api/server/update', (req, reply) => {
    const when = parseUpdateStartBody(req.body);
    if (when === null) return reply.code(400).send({ error: 'bad_request' });
    const device = req.headers[DEVICE_HEADER];
    const fromPeer = typeof device === 'string' && device !== '';
    const answer = updates.start(updateAsker(device, dir), { fromPeer, when });
    if (!answer.ok) return reply.code(answer.status).send({ error: answer.error });
    return reply.code(202).send(answer.state);
  });

  app.delete('/api/server/update', (_req, reply) => {
    const answer = updates.cancel();
    if (!answer.ok) return reply.code(answer.status).send({ error: answer.error });
    return reply.send(answer.state);
  });
}
