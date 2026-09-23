import { effectiveTagIds } from '../tags/rules.js';
import type { OrbitalDb } from '../db/database.js';
import type { PendingDecision, Runner } from '../runner/runner.js';
import type { SessionRegistry } from '../watcher/registry.js';
import type { PermissionMode, SessionRow, SessionSource, SessionStatus } from '../types.js';
import type { SubagentInfo, SubagentStore } from '../transcript/subagents.js';
import type { GitStore } from '../git/store.js';
import type { GitLocation } from '../git/gitState.js';
import type { IdeStore } from '../ide/store.js';
import type { IdeContext } from '../ide/protocol.js';

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
  subagents: SubagentStore;
  git: GitStore;
  ide: IdeStore;
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
  /**
   * Context tokens at the end of the session's last turn, or null when it was
   * never measured — which every terminal session permanently is, only
   * Orbital's own sessions having usage to read (spec `context-fill-arc`).
   * The map's arc divides it by the client-side context window; a null on
   * either side means no arc, never an invented one.
   */
  contextUsedTokens: number | null;
  /**
   * Map-only dismissal stamp (epoch ms), or null. Set by dragging the body
   * into the hole; the map hides a stamped session, everything else ignores
   * it (spec 2026-09-18-tag-clusters-design § 5).
   */
  mapDismissedAt: number | null;
  /**
   * When the user pinned this session (epoch ms), or null. A pinned session
   * is exempt from the map's release timer indefinitely and sorts to the
   * front of `GET /api/sessions` (spec
   * 2026-09-20-pinned-sessions-design § Server). Never non-null at the same
   * time as `mapDismissedAt`.
   */
  pinnedAt: number | null;
  /**
   * When a server restart cut this session's turn short (epoch ms), null
   * otherwise (spec 2026-09-21-session-autoheal-design). The session itself
   * is intact and resumed; what is missing is the rest of that one turn.
   * Cleared the next time the session actually runs a turn.
   */
  interruptedAt: number | null;
  tagIds: number[];
  status: SessionStatus;
  /**
   * `working`, but only because of `subagents`: the session's own turn ended
   * and it is now waiting for what it launched, which the CLI will hand back
   * without the human touching anything. Always false when `status` is
   * anything but `working`, and for every session orbital does not run.
   *
   * A flag rather than a fifth `SessionStatus`: the map's four states are a
   * visual vocabulary (size tier, ring, core, counts) and this changes none
   * of them — it changes the label, the way `interruptedAt` does.
   */
  awaitingSubagents: boolean;
  /**
   * Every subagent this session has ever seen, ended included, minus
   * whatever the user has dismissed — not just the running ones, so an
   * ended agent's moon (and its transcript) survives on the map until it is
   * dismissed (spec § "Moons outlive their agents"). Empty for every
   * session that has never launched one.
   */
  subagents: SubagentInfo[];
  /**
   * The question this session's CLI is blocked on, or null — which is what
   * every terminal and ended session gets, their decisions having died with
   * the process that parked them. On the snapshot rather than only on the hub
   * so a page reload recovers the question (spec
   * 2026-09-20-interactive-decisions-design § State and lifecycle).
   */
  pendingDecision: PendingDecision | null;
  /**
   * Where this session's `cwd` sits in git right now, or null when it is not
   * inside a repository — the live state of a directory rather than a record
   * of the session, which is why nothing about it is stored on the row (adr
   * `git-location-is-ambient-not-recorded`). The browser picks the trunk,
   * fork or tree mark from these facts; the mark itself is not on the wire.
   */
  git: GitLocation | null;
  /**
   * The editor open on this session's workspace right now, or null when none
   * is — live state of a directory rather than a fact about the session, the
   * same standing `git` has (adr `orbital-speaks-to-the-ide-itself`). Two
   * sessions in one workspace always show the same selection, for the same
   * reason two sessions in one checkout show the same branch.
   *
   * Open files deliberately do not ride here: there can be dozens, they
   * change constantly, and one surface wants them — so they are fetched from
   * `GET /api/sessions/:id/ide/open-files` instead.
   */
  ide: IdeContext | null;
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
    contextUsedTokens: row.context_used_tokens,
    mapDismissedAt: row.map_dismissed_at,
    pinnedAt: row.pinned_at,
    interruptedAt: row.interrupted_at,
    tagIds: effectiveTagIds(ctx.db, row.id),
    status: status ?? statusOf(ctx, row),
    awaitingSubagents: ctx.runner.awaitingSubagents(row.id),
    subagents: ctx.subagents.all(row.id),
    pendingDecision: ctx.runner.pendingDecision(row.id),
    git: ctx.git.locate(row.cwd),
    ide: ctx.ide.locate(row.cwd),
  };
}
