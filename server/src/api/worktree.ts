/**
 * The routes of Work in a worktree (spec 2026-11-02-work-in-a-worktree-design):
 * New Session's lookups, and a session's worktree state, removal and *Keep*.
 * The launch itself rides `POST /api/sessions`, and removal on end rides
 * `POST /api/sessions/:id/end`, both in `routes.ts`.
 *
 * Another device's lookups arrive here through federation's preHandler, by
 * `?machine=` or the body's `machine`, like every other route.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { isAbsolute } from 'node:path';
import { sessionColumns, sessions } from '../db/schema.js';
import type { OrbitalDb } from '../db/database.js';
import { expandHome } from '../paths.js';
import type { SessionRow } from '../types.js';
import type { WorktreeRemoveRefusal } from '@orbital/shared/worktree';
import type { WorktreeService } from '../worktree/service.js';

/** The HTTP status of each refusal of a removal. */
const REFUSAL_STATUS: Record<WorktreeRemoveRefusal, number> = {
  not_worktree: 404, worktree_shared: 409, worktree_live_terminal: 409, worktree_dirty: 409, worktree_state_changed: 409,
};

export function registerWorktreeRoutes(
  app: FastifyInstance,
  deps: { db: OrbitalDb; worktrees: WorktreeService; endSession: (id: string) => Promise<void> },
): void {
  const { db, worktrees } = deps;
  const rowOf = (id: string) =>
    db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow | undefined;
  /** A hand-typed directory, expanded as `POST /api/sessions` expands it; null when it is not absolute. */
  const dirOf = (raw: unknown): string | null => {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const cwd = expandHome(raw.trim());
    return isAbsolute(cwd) ? cwd : null;
  };

  app.get('/api/worktree/options', async (req, reply) => {
    const cwd = dirOf((req.query as { cwd?: unknown }).cwd);
    if (!cwd) return reply.code(400).send({ error: 'cwd_required' });
    return worktrees.options(cwd);
  });

  app.post('/api/worktree/fetch', async (req, reply) => {
    const cwd = dirOf(((req.body ?? {}) as { cwd?: unknown }).cwd);
    if (!cwd) return reply.code(400).send({ error: 'cwd_required' });
    const res = await worktrees.fetch(cwd);
    if (!res) return reply.code(400).send({ error: 'not_git' });
    return res;
  });

  app.get('/api/sessions/:id/worktree', async (req, reply) => {
    const row = rowOf((req.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // `null` is a body Fastify sends as the JSON literal.
    return reply.type('application/json').send(JSON.stringify(await worktrees.state(row)));
  });

  /**
   * Removes the session's worktree. The body says what the user confirmed:
   * `endSession` true when they were shown *End and remove*, and the `path`
   * they saw. When either no longer matches, nothing ends and nothing is
   * removed: 409 `worktree_state_changed` (adr
   * a-session-ends-only-when-the-user-ends-it).
   */
  app.post('/api/sessions/:id/worktree/remove', async (req, reply) => {
    const row = rowOf((req.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const { force, endSession, path } = (req.body ?? {}) as { force?: unknown; endSession?: unknown; path?: unknown };
    if (path !== undefined && typeof path !== 'string') return reply.code(400).send({ error: 'invalid_path' });
    const res = await worktrees.remove(row, {
      force: force === true, endSession: endSession === true, path, end: deps.endSession,
    });
    if (res.ok) return { ok: true };
    if (res.error === 'worktree_failed') return reply.code(500).send({ error: res.error, message: res.message });
    return reply.code(REFUSAL_STATUS[res.error]).send({ error: res.error });
  });

  app.post('/api/sessions/:id/worktree/keep', (req, reply) => {
    const row = rowOf((req.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const tree = worktrees.linkedTreeOf(row);
    if (!tree) return reply.code(404).send({ error: 'not_worktree' });
    worktrees.dismiss(tree.dirs.root);
    return { ok: true };
  });
}
