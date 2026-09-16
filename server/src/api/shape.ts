import { effectiveTagIds } from '../tags/rules.js';
import type { OrbitalDb } from '../db/database.js';
import type { Runner } from '../runner/runner.js';
import type { SessionRegistry } from '../watcher/registry.js';
import type { PermissionMode, SessionRow, SessionSource, SessionStatus } from '../types.js';

/**
 * Minimal context `toApiSession` needs to compute the REST session shape.
 * Kept separate from `RouteContext` (defined in routes.ts) so this module
 * has no dependency on routes.ts — index.ts imports from here too, and a
 * routes.ts -> index.ts import would create a cycle.
 */
export interface ShapeContext {
  db: OrbitalDb;
  registry: SessionRegistry;
  runner: Runner;
}

export interface ApiSession {
  id: string;
  cwd: string;
  title: string;
  firstAt: number | null;
  lastAt: number | null;
  messageCount: number;
  source: SessionSource;
  permissionMode: PermissionMode | null;
  /** The model Orbital asked for (an SDK `value`), or null. */
  model: string | null;
  /** The model that actually ran, as reported by the CLI, or null. */
  resolvedModel: string | null;
  parentId: string | null;
  tagIds: number[];
  status: SessionStatus;
}

export function statusOf(ctx: ShapeContext, row: SessionRow): SessionStatus {
  const fromRunner = ctx.runner.status(row.id);
  if (fromRunner) return fromRunner;
  const live = ctx.registry.get(row.id);
  if (live) return live.status;
  return 'ended';
}

/**
 * The REST-shaped session object shared by REST responses and the `sessions`
 * WS topic. `status`, when passed, overrides the computed status — needed by
 * registry-upsert publishing, where `ctx.registry` may not yet reflect the
 * live session that triggered the call (see index.ts's `publishLiveSession`).
 */
export function toApiSession(ctx: ShapeContext, row: SessionRow, status?: SessionStatus): ApiSession {
  return {
    id: row.id, cwd: row.cwd, title: row.title,
    firstAt: row.first_at, lastAt: row.last_at,
    messageCount: row.message_count, source: row.source,
    permissionMode: row.permission_mode,
    model: row.model, resolvedModel: row.resolved_model,
    parentId: row.parent_id,
    tagIds: effectiveTagIds(ctx.db, row.id),
    status: status ?? statusOf(ctx, row),
  };
}
