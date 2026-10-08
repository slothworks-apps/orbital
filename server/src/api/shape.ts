import { and, desc, eq, isNull } from 'drizzle-orm';
import { effectiveTagIds } from '../tags/rules.js';
import { compactionFailures, pendingRewinds, sessionHarnesses } from '../db/schema.js';
import { activeIndex, gateOf } from '../harness/logic.js';
import type { HarnessGate } from '../harness/types.js';
import type { OrbitalDb } from '../db/database.js';
import type { CompactingState, LastCompacted, PendingDecision, Runner } from '../runner/runner.js';
import type { LiveSessions } from '../watcher/registry.js';
import type { PermissionMode, SessionPurpose, SessionRow, SessionSource, SessionStatus } from '../types.js';
import type { SubagentInfo, SubagentStore } from '../transcript/subagents.js';
import type { BackgroundTaskInfo, BackgroundTaskStore } from '../transcript/backgroundTasks.js';
import type { RecentToolsStore } from '../transcript/recentTools.js';
import type { GitStore } from '../git/store.js';
import type { GitLocation } from '../git/gitState.js';
import type { BranchStatusStore } from '../git/branchStatusStore.js';
import type { OtherTree, SessionPlaces, WorkingTrees } from '../git/workingTrees.js';
import type { BranchStatus } from '../git/branchStatus.js';
import type { IdeStore } from '../ide/store.js';
import type { IdeContext } from '../ide/protocol.js';
import type { LimitsService } from '../limits/service.js';
import type { LimitWait } from '../limits/logic.js';

/** The usage-limit wire types, beside the session shape that carries one of them. */
export type { LimitWait, LimitWindow, LimitsSnapshot, ExtraUsage } from '../limits/logic.js';

/**
 * Minimal context `toApiSession` needs to compute the REST session shape.
 * Kept separate from `RouteContext` (defined in routes.ts) so this module
 * has no dependency on routes.ts — index.ts imports from here too, and a
 * routes.ts -> index.ts import would create a cycle.
 */
export interface ShapeContext {
  db: OrbitalDb;
  registry: LiveSessions;
  runner: Runner;
  subagents: SubagentStore;
  backgroundTasks: BackgroundTaskStore;
  recentTools: RecentToolsStore;
  git: GitStore;
  ide: IdeStore;
  branchStatus: BranchStatusStore;
  /** Usage-limit waits. Optional so a context built without one shapes every session as not waiting. */
  limits?: Pick<LimitsService, 'waitFor'>;
  /**
   * Where each session works now. Optional so a context built without one
   * shapes every session as working in its home, with no other trees.
   */
  trees?: Pick<WorkingTrees, 'places' | 'sessionsAt'>;
}

/** The working-tree wire type, beside the session shape that carries it. */
export type { OtherTree } from '../git/workingTrees.js';

export interface ApiSession {
  id: string;
  /**
   * The session's home: the first `cwd` its transcript recorded. It decides
   * the project, the map cluster and the tags, and it does not move (adr
   * `a-session-has-a-home-and-a-working-tree`).
   */
  cwd: string;
  /**
   * The tree the session works in now: the working-tree root of the last
   * `cwd` its transcript recorded, or that `cwd` outside a repository. The
   * home itself while the session has not left the home's tree, and while
   * nothing is known yet (spec 2026-10-07-live-working-tree-design § 2).
   */
  workingDir: string;
  /**
   * The trees running subagents work in, other than `workingDir`'s, the
   * tree with the most recently started agent first. Empty for an ended
   * session and for one whose agents all work in its own tree.
   */
  otherTrees: OtherTree[];
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
  /**
   * Context tokens at the end of the session's last turn, or null when it was
   * never measured — which every terminal session permanently is, only
   * Orbital's own sessions having usage to read (spec `context-fill-arc`).
   * The map's arc divides it by the client-side context window; a null on
   * either side means no arc, never an invented one.
   */
  contextUsedTokens: number | null;
  /**
   * When the user pinned this session (epoch ms), or null. A pinned session
   * stays on the map even once it has ended, and sorts to the front of
   * `GET /api/sessions` (spec 2026-09-20-pinned-sessions-design § Server,
   * spec 2026-09-24-sessions-end-only-by-hand-design § 3).
   */
  pinnedAt: number | null;
  /**
   * When the user ended this session (epoch ms), null while it is open and
   * for every terminal session, whose end is its CLI exiting rather than a
   * stamp (spec 2026-09-24-sessions-end-only-by-hand-design § 1).
   */
  endedAt: number | null;
  /**
   * When a server restart cut this session's turn short (epoch ms), null
   * otherwise (spec 2026-09-21-session-autoheal-design). The session itself
   * is intact and revives on the next message; what is missing is the rest
   * of that one turn. Cleared the next time the session actually runs a turn.
   */
  interruptedAt: number | null;
  tagIds: number[];
  status: SessionStatus;
  /**
   * `working`, but only because of what it launched — `subagents` or
   * `backgroundTasks` still running: the session's own turn ended and it is
   * now waiting for them. The name predates the background tasks; the UI's
   * label says which it waits for (spec 2026-09-28-background-tasks-design
   * § 3). Always false when `status` is anything but `working`, and for
   * every session orbital does not run.
   *
   * A flag rather than a fifth `SessionStatus`: the map's four states are a
   * visual vocabulary (size tier, ring, core, counts) and this changes none
   * of them — it changes the label, the way `interruptedAt` does.
   */
  awaitingSubagents: boolean;
  /**
   * In `GET /api/sessions/:id`, every subagent this session has ever seen,
   * ended included, so a finished agent keeps its row in the subagent list
   * and its transcript stays reachable (subagent list spec §§ 3, 5). In the
   * list and the `sessions` upserts, only the running ones
   * (`listedSubagents`); the client keeps the ended ones it already holds.
   * Empty for every session that has never launched one.
   */
  subagents: SubagentInfo[];
  /** How many subagents the session has had, ended included, in either shape of `subagents`. */
  subagentCount: number;
  /**
   * Background tasks — shell, monitor, workflow, MCP task — in start order
   * (spec 2026-09-28-background-tasks-design § 2): every one the session has
   * had in `GET /api/sessions/:id`, only the running ones in the list and its
   * upserts (`listedBackgroundTasks`). Kept in SQLite, so it survives a
   * restart. Empty for every session Orbital does not run: the task events
   * exist only on the SDK stream.
   */
  backgroundTasks: BackgroundTaskInfo[];
  /** How many background tasks the session has had, ended included, in either shape of `backgroundTasks`. */
  backgroundTaskCount: number;
  /**
   * The last 30 tool calls this session has made, in order. Used by
   * Archipelago ships and Desk cards to show the latest call (spec
   * 2026-10-01-map-themes-design § 5). Empty for terminal sessions and when
   * no tool has been called yet.
   *
   * Optional here for the same reason as `pendingDecision`: the server
   * always sends the field, absent and empty mean the same thing to every
   * reader, and requiring it would rewrite every session fixture in the suite.
   */
  recentTools?: import('../transcript/recentTools.js').RecentTool[];
  /**
   * The question this session's CLI is blocked on, or null — which is what
   * every terminal and ended session gets, their decisions having died with
   * the process that parked them. On the snapshot rather than only on the hub
   * so a page reload recovers the question (spec
   * 2026-09-20-interactive-decisions-design § State and lifecycle).
   */
  pendingDecision: PendingDecision | null;
  /**
   * Where this session's `workingDir` sits in git right now, or null when it is not
   * inside a repository — the live state of a directory rather than a record
   * of the session, which is why nothing about it is stored on the row (adr
   * `git-location-is-ambient-not-recorded`). The browser picks the trunk,
   * fork or tree mark from these facts; the mark itself is not on the wire.
   */
  git: GitLocation | null;
  /**
   * How far this session's working tree has got: its line changes and its
   * pull request, each present only while its setting is on and a reading
   * exists (spec 2026-09-30-branch-pr-and-line-changes-design § The wire).
   * Live state of a directory, the standing `git` has (adr
   * `git-location-is-ambient-not-recorded`), and read only for trees a
   * window has open — so the key is absent more often than not. Absent, not
   * null, when there is nothing to show.
   */
  branch?: BranchStatus;
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
  /**
   * The compaction running in this session right now, or null. In memory
   * only, and only ever set for a session this process runs: a terminal
   * session's compaction is known only afterwards, from its transcript
   * (spec 2026-09-28-context-compaction-design § Live state).
   */
  compacting: CompactingState | null;
  /**
   * The session's newest compaction failed and nothing has moved on from it
   * yet — no compaction has succeeded and no turn has started since. Opening
   * the session does not clear it; opening does not fix the context. Read
   * from `compaction_failures`, so it survives a restart (spec § Failure).
   */
  lastCompactionFailed: { at: number } | null;
  /**
   * The newest compaction this server process saw succeed, with its token
   * counts — what the map's `compacted · 186k → 22k` caption reads. In
   * memory only, and only for sessions this process runs.
   */
  lastCompacted: LastCompacted | null;
  /**
   * The rewind picked and not sent yet, or null (spec
   * 2026-09-29-rewind-design § Pending rewind). `hiddenCount` is the N the
   * client counted at pick time; `text` is the picked message's, which the
   * composer holds while the rewind is pending. On the snapshot so the
   * detached window and a reload show the same state.
   */
  rewindPending: { hiddenCount: number; text: string } | null;
  /**
   * Why Orbital started this session, or null. `harness_draft` is a harness
   * template's drafting conversation: the map shows it while it is open, no
   * list ever does, and once it ends it is gone (spec
   * 2026-10-02-harness-redesign-design § Overruled).
   */
  purpose: SessionPurpose | null;
  /**
   * The session's harness stands at a gate: `waiting` — NEEDS YOUR OK, and the
   * session reads `needs_input` — or `reviewing`, REVIEWER READING. Null
   * without a harness or a gate (spec 2026-10-02-harness-redesign-design § 2).
   */
  harnessGate: HarnessGate | null;
  /**
   * Where the session's live harness stands: `index` is the first step not
   * done (0-based, as the step routes count), `total` the step count; once
   * every step is done `index === total`. Null without a harness, or after
   * it was removed. Lets a list say "step n of m" without reading every
   * harness (spec 2026-10-05-mobile-next-design § 1 Server).
   */
  harnessStep: { index: number; total: number } | null;
  /**
   * The usage-limit window this session waits for, or null (spec
   * 2026-10-03-usage-limits-design § 1). While it waits the session reads
   * `idle`; like `awaitingSubagents` this is a label on a status, not a
   * fifth one (adr what-a-session-waits-for-is-a-label). Only Orbital's own
   * sessions ever wait.
   */
  limitWait: LimitWait | null;
  /**
   * The Claude directory (`claude_dirs.id`) the session belongs to — its
   * login, its transcripts, its limits (spec
   * 2026-10-04-multiple-claude-directories-design § 6). The names come from
   * `GET /api/sessions/defaults`; a client marks it only when two or more
   * directories are configured.
   */
  claudeDirId: number;
}

/** The gate the session's live harness stands at, or null. */
export function harnessGateOf(db: OrbitalDb, sessionId: string): HarnessGate | null {
  const row = db
    .select({ state: sessionHarnesses.state, removedAt: sessionHarnesses.removedAt })
    .from(sessionHarnesses)
    .where(eq(sessionHarnesses.sessionId, sessionId))
    .get();
  return row ? gateOf(row) : null;
}

/** Where the session's live harness stands, as `ApiSession.harnessStep` carries it. */
export function harnessStepOf(db: OrbitalDb, sessionId: string): { index: number; total: number } | null {
  const row = db
    .select({ state: sessionHarnesses.state, removedAt: sessionHarnesses.removedAt })
    .from(sessionHarnesses)
    .where(eq(sessionHarnesses.sessionId, sessionId))
    .get();
  if (!row || row.removedAt !== null) return null;
  const i = activeIndex(row.state);
  return { index: i === -1 ? row.state.length : i, total: row.state.length };
}

/** The session's pending rewind as the snapshot carries it, or null. */
export function rewindPendingOf(db: OrbitalDb, sessionId: string): { hiddenCount: number; text: string } | null {
  const row = db
    .select({ hiddenCount: pendingRewinds.hiddenCount, text: pendingRewinds.text })
    .from(pendingRewinds)
    .where(eq(pendingRewinds.sessionId, sessionId))
    .get();
  return row ?? null;
}

/** The newest compaction failure still standing for this session, or null. */
export function lastCompactionFailed(db: OrbitalDb, sessionId: string): { at: number } | null {
  const row = db
    .select({ at: compactionFailures.at })
    .from(compactionFailures)
    .where(and(eq(compactionFailures.sessionId, sessionId), isNull(compactionFailures.clearedAt)))
    .orderBy(desc(compactionFailures.at))
    .limit(1)
    .get();
  return row ? { at: row.at } : null;
}

/**
 * A session's status, from whoever knows best: the Runner while it holds a
 * process, then the terminal registry. Past both, the two kinds of session
 * part ways (spec 2026-09-24-sessions-end-only-by-hand-design § 1). A
 * terminal session nobody is running is over. An Orbital session is over only
 * once the user ended it — without that stamp it is merely asleep, and the
 * next message revives it.
 *
 * A pending rewind reads as waiting for input, whatever the row says: the
 * session was stopped to take it, and it is the user's turn to send (spec
 * 2026-09-29-rewind-design § Behaviour 5). Only past the Runner and the
 * registry — a session either of them holds has no pending rewind.
 */
export function statusOf(ctx: ShapeContext, row: SessionRow): SessionStatus {
  const fromRunner = ctx.runner.status(row.id);
  if (fromRunner) return fromRunner;
  const live = ctx.registry.get(row.id);
  if (live) return live.status;
  if (rewindPendingOf(ctx.db, row.id)) return 'needs_input';
  if (row.source !== 'web') return 'ended';
  if (row.ended_at !== null) return 'ended';
  // A gate waiting for the user is the session's state, asleep or not: it is
  // their turn (spec 2026-10-02-harness-redesign-design § 2). A live session
  // at a gate already reads `needs_input` from the Runner — its turn ended.
  return harnessGateOf(ctx.db, row.id) === 'waiting' ? 'needs_input' : 'idle';
}

/**
 * The list and its upserts carry only the tasks running now: everything that
 * reads a session from the list (the map, the phone's list, the working
 * checks) asks only what is running. A session that ran hundreds of commands
 * would otherwise grow the list past what one relay frame holds, and the
 * phone would get no list at all. `GET /api/sessions/:id` carries the whole
 * history, ended tasks included, for the open session.
 */
export function listedBackgroundTasks(tasks: BackgroundTaskInfo[]): BackgroundTaskInfo[] {
  return tasks.filter((t) => t.state === 'running');
}

/** The subagents the list and its upserts carry: the running ones, for the reason `listedBackgroundTasks` gives. */
export function listedSubagents(agents: SubagentInfo[]): SubagentInfo[] {
  return agents.filter((a) => a.state !== 'ended');
}

/**
 * The REST-shaped session object shared by REST responses and the `sessions`
 * WS topic. `status`, when passed, overrides the computed status — needed by
 * registry-upsert publishing, where `ctx.registry` may not yet reflect the
 * live session that triggered the call (see index.ts's `publishLiveSession`).
 *
 * `history` is the detail's shape (`GET /api/sessions/:id`): every subagent
 * and background task the session has had. Without it, only the running ones
 * (`listedSubagents`, `listedBackgroundTasks`), with the totals beside them.
 */
export function toApiSession(
  ctx: ShapeContext, row: SessionRow, status?: SessionStatus, opts: { history?: boolean } = {},
): ApiSession {
  const agents = ctx.subagents.all(row.id);
  const tasks = ctx.backgroundTasks.all(row.id);
  const resolved = status ?? statusOf(ctx, row);
  const { workingDir, otherTrees } = placesOf(ctx, row, agents, resolved);
  return {
    id: row.id, cwd: row.cwd, workingDir, otherTrees, title: row.title,
    firstAt: row.first_at, lastAt: row.last_at,
    messageCount: row.message_count, source: row.source,
    permissionMode: row.permission_mode,
    model: row.model, resolvedModel: row.resolved_model,
    contextUsedTokens: row.context_used_tokens,
    pinnedAt: row.pinned_at,
    endedAt: row.ended_at,
    interruptedAt: row.interrupted_at,
    tagIds: effectiveTagIds(ctx.db, row.id),
    status: resolved,
    awaitingSubagents: ctx.runner.awaitingSubagents(row.id),
    subagents: opts.history ? agents : listedSubagents(agents),
    subagentCount: agents.length,
    backgroundTasks: opts.history ? tasks : listedBackgroundTasks(tasks),
    backgroundTaskCount: tasks.length,
    recentTools: ctx.recentTools.all(row.id),
    pendingDecision: ctx.runner.pendingDecision(row.id),
    git: ctx.git.locate(workingDir),
    ...branchOf(ctx, workingDir),
    ide: ctx.ide.locate(workingDir),
    compacting: ctx.runner.compacting(row.id),
    lastCompactionFailed: lastCompactionFailed(ctx.db, row.id),
    lastCompacted: ctx.runner.lastCompacted(row.id),
    rewindPending: rewindPendingOf(ctx.db, row.id),
    purpose: row.purpose ?? null,
    harnessGate: harnessGateOf(ctx.db, row.id),
    harnessStep: harnessStepOf(ctx.db, row.id),
    limitWait: ctx.limits?.waitFor(row.id) ?? null,
    claudeDirId: row.claude_dir_id,
  };
}

/** Where the session works now: its home and nothing else without a `trees` reader. */
function placesOf(ctx: ShapeContext, row: SessionRow, agents: SubagentInfo[], status: SessionStatus): SessionPlaces {
  if (!ctx.trees) return { workingDir: row.cwd, otherTrees: [] };
  return ctx.trees.places(row, agents, status === 'ended');
}

/** `{ branch }` when there is one, `{}` otherwise — the key is omitted, not null. */
function branchOf(ctx: ShapeContext, cwd: string): { branch?: BranchStatus } {
  const branch = ctx.branchStatus.get(cwd);
  return branch ? { branch } : {};
}
