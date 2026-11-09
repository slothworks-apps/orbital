/**
 * Worktree setup in the background (spec
 * 2026-11-09-worktree-setup-in-background-design): a session launched into a
 * worktree exists from the launch's answer, and its worktree is made after
 * it — named, checked out, its local files copied — before the session
 * starts there on its own.
 *
 * `SetupStore` holds the `session_setups` rows and their in-memory mirror,
 * which the session shape reads; `SetupService` runs the steps, Try again,
 * Discard, and what a restart finds half done.
 */

import { eq } from 'drizzle-orm';
import type { SessionSetup, SetupLaunchSettings, SetupPhase, SetupQueuedMessage } from '@orbital/shared/worktree';
import type { OrbitalDb } from '../db/database.js';
import { sessionSetups } from '../db/schema.js';
import type { ErrorLog } from '../errors/log.js';
import type { McpjsonDecisions } from '../mcp/mcpjson.js';
import { WorktreeAddError, type LaunchCheck, type WorktreeService } from './service.js';

/** What a restart says of a setup it found running. */
export const INTERRUPTED_MESSAGE = 'Orbital stopped while the worktree was being set up.';

/** The sentence a failure gets when nothing in its output says more. */
export const FALLBACK_MESSAGE = "Couldn't create the worktree.";

type Step = 1 | 2 | 3;

export interface SetupRecord {
  sessionId: string;
  phase: SetupPhase;
  step: Step;
  branch: string | null;
  path: string | null;
  repoRoot: string;
  /** What is on disk for a rollback after a restart: see the column. */
  made: 'none' | 'dir' | 'worktree';
  /** The naming call's name for the session. */
  title: string | null;
  launch: SetupLaunchSettings;
  prompt: string;
  attachments: string[];
  mcpjson: McpjsonDecisions | null;
  queued: SetupQueuedMessage[];
  /** The session process started: the queue is being handed over. */
  sessionStarted: boolean;
  message: string | null;
  errorId: number | null;
  startedAt: number;
  readyInMs: number | null;
}

/** The phase a setup starts in: step 1 is done at once when the user typed the branch. */
export function firstPhaseOf(launch: Pick<SetupLaunchSettings, 'branch'>): { phase: SetupPhase; step: Step; branch: string | null } {
  return launch.branch ? { phase: 'checkout', step: 2, branch: launch.branch } : { phase: 'naming', step: 1, branch: null };
}

export class SetupStore {
  private readonly records = new Map<string, SetupRecord>();
  private closed = false;
  /** Told of every change, to publish the session's row. */
  onChange: (sessionId: string) => void = () => {};

  constructor(private readonly db: OrbitalDb) {
    this.load();
  }

  /** Reads the stored setups. */
  load(): void {
    this.records.clear();
    for (const row of this.db.select().from(sessionSetups).all()) {
      this.records.set(row.sessionId, {
        sessionId: row.sessionId,
        phase: row.phase,
        step: (row.step === 1 || row.step === 2 ? row.step : 3),
        branch: row.branch,
        path: row.path,
        repoRoot: row.repoRoot,
        made: row.made,
        title: row.title,
        launch: row.launch,
        prompt: row.prompt,
        attachments: Array.isArray(row.attachments) ? row.attachments : [],
        mcpjson: row.mcpjson ?? null,
        queued: Array.isArray(row.queued) ? row.queued : [],
        sessionStarted: row.sessionStarted === 1,
        message: row.message,
        errorId: row.errorId,
        startedAt: row.startedAt,
        readyInMs: row.readyInMs,
      });
    }
  }

  get(sessionId: string): SetupRecord | undefined {
    return this.records.get(sessionId);
  }

  all(): SetupRecord[] {
    return [...this.records.values()];
  }

  /** Setting up or not started: the session has no process of its own yet. */
  pending(sessionId: string): boolean {
    const rec = this.records.get(sessionId);
    return rec !== undefined && rec.phase !== 'ready';
  }

  /** The session's `setup` on the wire, or null for a session launched without one. */
  setupOf(sessionId: string): SessionSetup | null {
    const rec = this.records.get(sessionId);
    if (!rec) return null;
    return {
      phase: rec.phase, step: rec.step, branch: rec.branch, path: rec.path,
      readyInMs: rec.readyInMs, message: rec.message, errorId: rec.errorId,
      prompt: rec.prompt, attachments: rec.attachments, queued: rec.queued, launch: rec.launch,
    };
  }

  create(rec: SetupRecord): void {
    if (this.closed) return;
    this.records.set(rec.sessionId, rec);
    this.db.insert(sessionSetups).values(toColumns(rec))
      .onConflictDoUpdate({ target: sessionSetups.sessionId, set: toColumns(rec) })
      .run();
    this.onChange(rec.sessionId);
  }

  /** Changes a setup and publishes its session; nothing for one that is gone. */
  update(sessionId: string, patch: Partial<Omit<SetupRecord, 'sessionId'>>): SetupRecord | undefined {
    const rec = this.records.get(sessionId);
    if (!rec || this.closed) return undefined;
    Object.assign(rec, patch);
    this.db.update(sessionSetups).set(toColumns(rec)).where(eq(sessionSetups.sessionId, sessionId)).run();
    this.onChange(sessionId);
    return rec;
  }

  /** A message to a session not started yet: kept for its start. False when the session is not waiting for one. */
  queue(sessionId: string, message: SetupQueuedMessage): boolean {
    const rec = this.records.get(sessionId);
    if (!rec || rec.phase === 'ready') return false;
    this.update(sessionId, { queued: [...rec.queued, message] });
    return true;
  }

  delete(sessionId: string): void {
    if (this.closed) return;
    this.records.delete(sessionId);
    this.db.delete(sessionSetups).where(eq(sessionSetups.sessionId, sessionId)).run();
  }

  /** The database is about to close: from here on nothing is written. */
  close(): void {
    this.closed = true;
  }
}

function toColumns(rec: SetupRecord) {
  return {
    sessionId: rec.sessionId, phase: rec.phase, step: rec.step, branch: rec.branch, path: rec.path,
    repoRoot: rec.repoRoot, made: rec.made, title: rec.title, launch: rec.launch,
    prompt: rec.prompt, attachments: rec.attachments, mcpjson: rec.mcpjson, queued: rec.queued,
    sessionStarted: rec.sessionStarted ? 1 : 0, message: rec.message, errorId: rec.errorId,
    startedAt: rec.startedAt, readyInMs: rec.readyInMs,
  };
}

/** A failure whose plain sentence is known where it happened. */
export class SetupFailure extends Error {
  constructor(readonly sentence: string, detail: string) {
    super(detail);
  }
}

/**
 * The one plain sentence a failed setup shows, from what git or the system
 * said. The full output goes to the error log.
 */
export function failureSentence(err: unknown, branch: string | null): string {
  if (err instanceof SetupFailure) return err.sentence;
  const text = err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}` : String(err);
  if (/a branch named .* already exists/i.test(text)) {
    return branch
      ? `Git refused: the branch ${branch} appeared while the worktree was being set up.`
      : 'Git refused: the branch appeared while the worktree was being set up.';
  }
  if (/ENOSPC|no space left/i.test(text)) return 'The disk is full.';
  if (/\.lock\b|is locked/i.test(text)) return 'The repository is locked by another git process.';
  if (/EACCES|EPERM|permission denied/i.test(text)) return 'Orbital is not allowed to write in the repository.';
  if (/not a git repository/i.test(text)) return 'The folder is no longer in a git repository.';
  if (/No free (branch name|directory)/.test(text)) return err instanceof Error ? err.message : FALLBACK_MESSAGE;
  return FALLBACK_MESSAGE;
}

export interface SetupServiceDeps {
  store: SetupStore;
  worktrees: Pick<WorktreeService,
    'checkLaunch' | 'nameLaunchBranch' | 'reserveLaunchDir' | 'addLaunchWorktree' | 'copyLaunchFiles'
    | 'launchCwdOf' | 'rollbackLaunch' | 'rollbackInterrupted'>;
  errors: Pick<ErrorLog, 'record'>;
  /**
   * Writes the `.mcp.json` answers into the worktree and starts the session
   * there with its first prompt. Throws when the session did not start, and
   * leaves no process behind when it throws.
   */
  start: (rec: SetupRecord, cwd: string) => Promise<void>;
  /** Hands one queued message to the started session, the way the composer's goes. */
  deliver: (sessionId: string, message: SetupQueuedMessage) => Promise<void>;
  /** Stops a session that started while it was being discarded. */
  stop: (sessionId: string) => Promise<void>;
  now?: () => number;
}

/** One run of the steps. Discard sets `cancelled`; the step in flight finishes, and what it made is taken away. */
interface Run {
  cancelled: boolean;
  done: Promise<void>;
}

export class SetupService {
  private readonly runs = new Map<string, Run>();
  /** The rollbacks a restart set off, by session: Try again and Discard wait for them. */
  private readonly recovering = new Map<string, Promise<void>>();
  /** Discards of started sessions still cleaning up. */
  private readonly cleanups = new Set<Promise<void>>();
  private closing = false;
  private readonly now: () => number;

  constructor(private readonly deps: SetupServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Runs the setup of a session whose record was just written. `check` is the launch's own, when it made one. */
  begin(sessionId: string, check?: LaunchCheck): void {
    const run: Run = { cancelled: false, done: Promise.resolve() };
    run.done = this.run(sessionId, run, check).finally(() => {
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId);
    });
    this.runs.set(sessionId, run);
  }

  /** Try again: from step 1, with the same settings, the prompt and queue kept. */
  async retry(sessionId: string): Promise<'ok' | 'not_found' | 'not_failed'> {
    const rec = this.deps.store.get(sessionId);
    if (!rec) return 'not_found';
    if (rec.phase !== 'failed' || this.runs.has(sessionId)) return 'not_failed';
    // Claimed before anything is awaited, so a second Try again is refused.
    const reset = { ...firstPhaseOf(rec.launch), path: null, made: 'none' as const, title: null, message: null, errorId: null, startedAt: this.now(), readyInMs: null };
    const before = this.recovering.get(sessionId);
    this.deps.store.update(sessionId, reset);
    if (before) await before;
    if (this.deps.store.pending(sessionId)) this.begin(sessionId);
    return 'ok';
  }

  /**
   * Discard: the record goes at once, a run in flight is told to stop and
   * takes away what it made once its step has finished. The caller deletes
   * the session itself. False when the session is not in setup.
   */
  discard(sessionId: string): boolean {
    const rec = this.deps.store.get(sessionId);
    if (!rec || rec.phase === 'ready') return false;
    const run = this.runs.get(sessionId);
    if (run) run.cancelled = true;
    this.deps.store.delete(sessionId);
    // Started already, still handing its queue over: the process goes, then the worktree it runs in.
    if (rec.sessionStarted && rec.path && rec.branch) {
      const { path, branch } = rec;
      const cleanup = (async () => {
        await run?.done;
        await this.deps.stop(sessionId);
        await this.deps.worktrees.rollbackLaunch({ repoRoot: rec.repoRoot, path, branch, added: true, sessionId });
      })().catch((err) => { this.recordError(sessionId, 'A discarded session could not be cleaned up.', err); })
        .finally(() => this.cleanups.delete(cleanup));
      this.cleanups.add(cleanup);
    }
    return true;
  }

  /**
   * At boot: a setup the previous server was running is rolled back from
   * what its record says was made, and waits as not started. One whose
   * session had already started hands over the rest of its queue.
   */
  recover(): void {
    for (const rec of this.deps.store.all()) {
      if (rec.phase === 'ready' || rec.phase === 'failed') continue;
      if (rec.sessionStarted) {
        const run: Run = { cancelled: false, done: Promise.resolve() };
        run.done = this.handOver(rec.sessionId, run).catch((err) => { this.recordError(rec.sessionId, 'The setup could not finish after a restart.', err); })
          .finally(() => { if (this.runs.get(rec.sessionId) === run) this.runs.delete(rec.sessionId); });
        this.runs.set(rec.sessionId, run);
        continue;
      }
      const made = rec.made;
      const path = rec.path;
      const branch = rec.branch;
      this.deps.store.update(rec.sessionId, { phase: 'failed', made: 'none', message: INTERRUPTED_MESSAGE, errorId: null });
      if (made === 'none' || !path || !branch) continue;
      const rollback = this.deps.worktrees
        .rollbackInterrupted({ repoRoot: rec.repoRoot, path, branch, made, sessionId: rec.sessionId })
        .finally(() => this.recovering.delete(rec.sessionId));
      this.recovering.set(rec.sessionId, rollback);
    }
  }

  /** The server is closing: runs stop at their next step and leave their record to the next boot. */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.recovering.values(), ...this.cleanups]);
    this.deps.store.close();
  }

  private async run(sessionId: string, run: Run, given?: LaunchCheck): Promise<void> {
    const { store, worktrees } = this.deps;
    const stopped = () => run.cancelled || this.closing;
    let rec = store.get(sessionId);
    if (!rec) return;
    let step: Step = rec.step;
    let branch = rec.branch;
    let made: { repoRoot: string; path: string; branch: string; added: boolean; sessionId: string } | null = null;
    const undo = async () => {
      if (made && !this.closing) await worktrees.rollbackLaunch(made);
    };
    try {
      let check: LaunchCheck;
      if (given) {
        check = given;
      } else {
        const res = await worktrees.checkLaunch(rec.launch);
        if (!res.ok) throw new SetupFailure(res.message, res.message);
        check = res;
      }
      if (stopped()) return;

      // 1. The branch.
      if (!branch) {
        const named = await worktrees.nameLaunchBranch(check, {
          prompt: rec.prompt, sessionId, claudeDirId: rec.launch.claudeDirId,
        });
        // A discard while the call ran: its answer is not wanted.
        if (stopped()) return;
        branch = named.branch;
        step = 2;
        rec = store.update(sessionId, { phase: 'checkout', step, branch, title: named.title });
        if (!rec) return;
      }
      step = 2;

      // 2. The checkout.
      const path = worktrees.reserveLaunchDir(check, branch);
      made = { repoRoot: check.repoRoot, path, branch, added: false, sessionId };
      store.update(sessionId, { path, made: 'dir' });
      // Before git runs: a restart while it does finds out from git whether it got as far.
      store.update(sessionId, { made: 'worktree' });
      try {
        await worktrees.addLaunchWorktree(check, path, branch);
        made.added = true;
      } catch (err) {
        if (!(err instanceof WorktreeAddError)) made.added = true;
        throw err;
      }
      if (stopped()) return await undo();

      // 3. The local files.
      step = 3;
      store.update(sessionId, { phase: 'copy', step });
      await worktrees.copyLaunchFiles(check, path);
      if (stopped()) return await undo();

      // The session, in the worktree.
      rec = store.get(sessionId);
      if (!rec) return await undo();
      await this.deps.start(rec, worktrees.launchCwdOf(check, rec.launch.cwd, path));
      if (run.cancelled) {
        await this.deps.stop(sessionId);
        return await undo();
      }
      made = null;
      store.update(sessionId, { sessionStarted: true });
    } catch (err) {
      if (this.closing) return;
      await undo();
      if (run.cancelled) return;
      const sentence = failureSentence(err, branch);
      const errorId = this.recordError(sessionId, `A worktree could not be set up: ${sentence}`, err, {
        step, branch, path: made?.path ?? null, base: rec?.launch.base,
      });
      store.update(sessionId, { phase: 'failed', step, made: 'none', message: sentence, errorId });
      return;
    }
    await this.handOver(sessionId, run);
  }

  /**
   * The queued messages, oldest first, each taken off the record only once
   * the session has it; one written meanwhile joins the end. Then `ready`.
   */
  private async handOver(sessionId: string, run: Run): Promise<void> {
    const { store } = this.deps;
    for (;;) {
      if (run.cancelled || this.closing) return;
      const rec = store.get(sessionId);
      if (!rec) return;
      const next = rec.queued[0];
      if (!next) break;
      try {
        await this.deps.deliver(sessionId, next);
      } catch (err) {
        // Not left at the head, where it would stop the rest: the log keeps its text.
        this.recordError(sessionId, 'A message written while the worktree was set up could not be sent.', err, { text: next.text });
      }
      if (run.cancelled || this.closing) return;
      const now = store.get(sessionId);
      if (!now) return;
      store.update(sessionId, { queued: now.queued.slice(1) });
    }
    const rec = store.get(sessionId);
    if (!rec) return;
    store.update(sessionId, {
      phase: 'ready', step: 3, made: 'none', readyInMs: this.now() - rec.startedAt,
      prompt: '', attachments: [], queued: [], message: null, errorId: null,
    });
  }

  private recordError(sessionId: string, message: string, err: unknown, context: Record<string, unknown> = {}): number | null {
    if (this.closing) return null;
    try {
      return this.deps.errors.record({
        source: 'server', kind: 'worktree_failed', sessionId, message,
        detail: err instanceof Error ? err.message : String(err), context,
      }).id;
    } catch (e) {
      console.warn('orbital: could not record a worktree setup failure:', e);
      return null;
    }
  }
}
