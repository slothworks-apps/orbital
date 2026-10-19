import type { FastifyInstance } from 'fastify';
import type { UpdateService } from '../update/service.js';

/**
 * Updating this server from any member of the group, the phone included,
 * and from the local `orbital` CLI (spec 2026-10-19-headless-server-design
 * § Updating from the group). Both routes are on the members' allowlist;
 * any member may call them, there is no primary check.
 *
 * `POST` reads nothing from the request: no body, no query. 202 with the
 * state when the update starts; 409 `no_update`, `updating` or
 * `not_set_up`; 501 `not_packaged`.
 */
export function registerServerUpdateRoutes(app: FastifyInstance, updates: UpdateService): void {
  app.get('/api/server/update', () => updates.state());

  app.post('/api/server/update', (_req, reply) => {
    const answer = updates.start();
    if (!answer.ok) return reply.code(answer.status).send({ error: answer.error });
    return reply.code(202).send(answer.state);
  });
}
