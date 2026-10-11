import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { sessions } from '../db/schema.js';
import { isTerminalSize } from '../terminal/store.js';
import type { RouteContext } from './routes.js';

/**
 * The terminals' REST half (spec 2026-10-05-embedded-terminal-design § Routes).
 * The socket, `/ws/terminal/:id`, is registered beside `/ws` in `index.ts`,
 * under the same Origin check. None of these is on the phone's allowlist.
 */
export function registerTerminalRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, terminals } = ctx;

  app.get('/api/sessions/:id/terminals', (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { terminals: terminals.list(id) };
  });

  app.post('/api/sessions/:id/terminals', (req, reply) => {
    const { id } = req.params as { id: string };
    const { cols, rows } = (req.body ?? {}) as { cols?: unknown; rows?: unknown };
    const row = db.select({ cwd: sessions.cwd }).from(sessions).where(eq(sessions.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not found' });
    // A worktree removed since the session ran: a shell would start in `/`
    // and look like it worked.
    if (!row.cwd || !existsSync(row.cwd)) return reply.code(409).send({ error: 'cwd_missing' });
    const size = isTerminalSize(cols) && isTerminalSize(rows) ? { cols, rows } : undefined;
    return reply.code(201).send(terminals.open(id, row.cwd, size));
  });

  app.post('/api/terminals/:id/restart', (req, reply) => {
    const { id } = req.params as { id: string };
    const { cols, rows } = (req.body ?? {}) as { cols?: unknown; rows?: unknown };
    const terminal = terminals.get(id);
    if (!terminal) return reply.code(404).send({ error: 'not found' });
    if (!existsSync(terminal.cwd)) return reply.code(409).send({ error: 'cwd_missing' });
    const size = isTerminalSize(cols) && isTerminalSize(rows) ? { cols, rows } : undefined;
    const restarted = terminals.restart(id, size);
    if (restarted === 'missing') return reply.code(404).send({ error: 'not found' });
    if (restarted === 'running') return reply.code(409).send({ error: 'running' });
    return restarted;
  });

  app.delete('/api/terminals/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    if (!terminals.close(id)) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });
}

