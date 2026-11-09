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
import { startedTurn, type DeliveryOutcome } from '../api/delivery.js';
import { WorktreeAddError, type LaunchCheck, type WorktreeService } from './service.js';

/** What a restart says of a setup it found running. */
const INTERRUPTED_MESSAGE = 'Orbital stopped while the worktree was being set up.';

/** The sentence a failure gets when nothing in its output says more. */
const FALLBACK_MESSAGE = "Couldn't create the worktree.";

type Step = 1 | 2 | 3;

export interface SetupRecord {
  sessionId: string;
  /**
   * `discarded` is a tombstone: the session is gone, and the record stays
   * only until what its setup made is rolled back, so a restart in between
   * finishes the rollback.
   */
  phase: SetupPhase | 'discarded';
  step: Step;
  branch: string | null;
  path: string | null;
  repoRoot: string;
  /** What is on disk for a rollback after a restart: see the column. */
  made: 'none' | 'worktree';
  /** The naming call's name for the session. */
  title: string | null;
  launch: SetupLaunchSettings;
  prompt: string;
  attachments: string[];
  mcpjson: McpjsonDecisions | null;
  queued: SetupQueuedMessage[];
  /** The session process started: what is left of the queue is being handed over. */
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
  /** Queues waiting for their session's turn to move, by session. */
  private readonly waiters = new Map<string, Set<() => void>>();
  private closed = false;
  /** Told of every change, to publish the session's row. */
  onChange: (sessionId: string) => void = () => {};

  constructor(private readonly db: OrbitalDb) {
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

  /** Any record, a discarded one's tombstone included. */
  get(sessionId: string): SetupRecord | undefined {
    return this.records.get(sessionId);
  }

  all(): SetupRecord[] {
    return [...this.records.values()];
  }

  /** Setting up or not started: the session has no process of its own yet. */
  pending(sessionId: string): boolean {
    const phase = this.records.get(sessionId)?.phase;
    return phase !== undefined && phase !== 'ready' && phase !== 'discarded';
  }

  /** The session's `setup` on the wire, or null for a session launched without one. */
  setupOf(sessionId: string): SessionSetup | null {
    const rec = this.records.get(sessionId);
    if (!rec || rec.phase === 'discarded') return null;
    return {
      phase: rec.phase, step: rec.step, branch: rec.branch, path: rec.path,
      readyInMs: rec.readyInMs, message: rec.message, errorId: rec.errorId,
      prompt: rec.prompt, attachments: rec.attachments, queued: rec.queued, launch: rec.launch,
    };
  }

  /**
   * Writes a new setup through `tx` — the launch's transaction, which writes
   * the session's row in the same go — and keeps it once written. Does not
   * publish: the caller does, once the transaction is committed.
   */
  insert(rec: SetupRecord, tx: Pick<OrbitalDb, 'insert'> = this.db): void {
    if (this.closed) return;
    tx.insert(sessionSetups).values(toColumns(rec))
      .onConflictDoUpdate({ target: sessionSetups.sessionId, set: toColumns(rec) })
      .run();
    this.records.set(rec.sessionId, rec);
  }

  /** Changes a setup and publishes its session; nothing for one that is gone. */
  update(sessionId: string, patch: Partial<Omit<SetupRecord, 'sessionId'>>): SetupRecord | undefined {
    const rec = this.records.get(sessionId);
    if (!rec || this.closed) return undefined;
    const next = { ...rec, ...patch };
    // Written before it is kept: a write that throws leaves the record as the db has it.
    this.db.update(sessionSetups).set(toColumns(next)).where(eq(sessionSetups.sessionId, sessionId)).run();
    Object.assign(rec, patch);
    this.onChange(sessionId);
    return rec;
  }

  /**
   * A message to a session not started yet: kept for its start. Also one to
   * a started session whose queue still waits for its first turn to end,
   * which joins the end so nothing goes in ahead of what was written first.
   * False when the session is waiting for neither.
   */
  queue(sessionId: string, message: SetupQueuedMessage): boolean {
    const rec = this.records.get(sessionId);
    if (!rec || rec.phase === 'discarded' || (rec.phase === 'ready' && rec.queued.length === 0)) return false;
    this.update(sessionId, { queued: [...rec.queued, message] });
    return true;
  }

  delete(sessionId: string): void {
    if (this.closed) return;
    this.db.delete(sessionSetups).where(eq(sessionSetups.sessionId, sessionId)).run();
    this.records.delete(sessionId);
    this.settled(sessionId);
  }

  /**
   * At boot, before the claims are cleared: the previous server's runner
   * held this session, so its setup got as far as starting it, whether or
   * not `sessionStarted` was written before the stop.
   */
  claimedBeforeStop(sessionId: string): void {
    const rec = this.records.get(sessionId);
    if (rec && !rec.sessionStarted && (rec.phase === 'naming' || rec.phase === 'checkout' || rec.phase === 'copy')) {
      this.update(sessionId, { sessionStarted: true });
    }
  }

  /** Sessions whose rows someone else has deleted already — the retention sweep. */
  forget(sessionIds: string[]): void {
    for (const id of sessionIds) {
      this.records.delete(id);
      this.settled(id);
    }
  }

  /**
   * The session's turn, its decision or its process moved: a queue waiting
   * for the first turn to end looks again. The runner's callbacks call it.
   */
  settled(sessionId: string): void {
    const waiting = this.waiters.get(sessionId);
    if (!waiting) return;
    this.waiters.delete(sessionId);
    for (const wake of waiting) wake();
  }

  /** Resolves at the session's next `settled`, or when the store closes. */
  untilSettled(sessionId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const waiting = this.waiters.get(sessionId) ?? new Set();
      waiting.add(resolve);
      this.waiters.set(sessionId, waiting);
    });
  }

  /** Every queue waiting on a turn looks again: the server is closing. */
  wakeAll(): void {
    for (const id of [...this.waiters.keys()]) this.settled(id);
  }

  /** The database is about to close: from here on nothing is written, and nothing waits. */
  close(): void {
    this.closed = true;
    this.wakeAll();
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
function failureSentence(err: unknown, branch: string | null): string {
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
  /** Hands one queued message to the started session, the way the composer's goes; answers what the delivery did. */
  deliver: (sessionId: string, message: SetupQueuedMessage) => Promise<DeliveryOutcome>;
  /**
   * Where the started session's turn is: `running` while it works or waits
   * on a decision, `over` once it has ended (or its process has gone, which
   * a message revives), `gone` for a session ended or deleted meanwhile.
   * Read again at every `SetupStore.settled`.
   */
  turnOf: (sessionId: string) => 'running' | 'over' | 'gone';
  /**
   * Hands one queued message to the session's wait for a limit reset, which
   * sends it at the reset; false when the session is not waiting for one.
   */
  toLimitWait: (sessionId: string, message: SetupQueuedMessage) => boolean;
  /** Stops a session that started while it was being discarded. */
  stop: (sessionId: string) => Promise<void>;
  now?: () => number;
  /** How long closing waits for a start or a delivery in flight; `CLOSE_WAIT_MS` by default. */
  closeWaitMs?: number;
}

/**
 * How long closing waits for a session start or a queued message's delivery
 * already in flight, so what it did is written before the db closes. One
 * that takes longer is found by the next boot from the session's claim.
 */
const CLOSE_WAIT_MS = 5_000;

/** One run of the steps, or of the queue's handover. Discard sets `cancelled`; the step in flight finishes, and what it made is taken away. */
interface Run {
  cancelled: boolean;
  done: Promise<void>;
}

export class SetupService {
  private readonly runs = new Map<string, Run>();
  /** The rollbacks a restart set off, by session: Try again and Discard wait for them. */
  private readonly recovering = new Map<string, Promise<void>>();
  /** Discards still rolling back what their setup made. */
  private readonly cleanups = new Set<Promise<void>>();
  /** A start or a delivery and the write that records it: closing waits for them. */
  private readonly inFlight = new Set<Promise<unknown>>();
  private closing = false;
  private readonly now: () => number;
  private readonly closeWaitMs: number;

  constructor(private readonly deps: SetupServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.closeWaitMs = deps.closeWaitMs ?? CLOSE_WAIT_MS;
  }

  /** Runs the setup of a session whose record was just written. `check` is the launch's own, when it made one. */
  begin(sessionId: string, check?: LaunchCheck): void {
    this.spawn(sessionId, (run) => this.run(sessionId, run, check), 'A worktree setup stopped on an error.');
  }

  /**
   * A message joined the queue of a started session that nothing is handing
   * over — one a restart left: the queue goes in now, oldest first, ahead of
   * the new one.
   */
  resume(sessionId: string): void {
    if (this.closing || this.runs.has(sessionId)) return;
    const rec = this.deps.store.get(sessionId);
    if (rec?.phase !== 'ready' || rec.queued.length === 0) return;
    this.spawn(sessionId, (run) => this.handOver(sessionId, run), 'The messages written during setup could not be sent.');
  }

  /** Try again: from step 1, with the same settings, the prompt and queue kept. */
  async retry(sessionId: string): Promise<'ok' | 'not_found' | 'not_failed'> {
    const rec = this.deps.store.get(sessionId);
    if (!rec || rec.phase === 'discarded') return 'not_found';
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
   * Discard: the session is gone for the clients at once. A run in flight is
   * told to stop and takes away what it made once its step has finished;
   * until then the record stays as a tombstone, so a restart in between
   * rolls it back at boot. The caller deletes the session itself. False
   * when the session is not in setup.
   */
  discard(sessionId: string): boolean {
    const { store } = this.deps;
    const rec = store.get(sessionId);
    if (!rec || rec.phase === 'ready' || rec.phase === 'discarded') return false;
    const run = this.runs.get(sessionId);
    if (run) run.cancelled = true;
    const recovering = this.recovering.get(sessionId);
    if (!run && !recovering) {
      store.delete(sessionId);
      return true;
    }
    store.update(sessionId, { phase: 'discarded' });
    const cleanup = (async () => {
      await run?.done;
      await recovering;
      // A run that stopped for the close left its rollback to the tombstone.
      if (!this.closing) store.delete(sessionId);
    })().catch((err) => { this.recordError(sessionId, 'A discarded session could not be cleaned up.', err); })
      .finally(() => this.cleanups.delete(cleanup));
    this.cleanups.add(cleanup);
    return true;
  }

  /**
   * At boot. A setup the previous server was running is rolled back from
   * what its record says was made, and waits as not started; a discarded
   * one's rollback is finished and its tombstone goes. One whose session
   * had started is ready; what is left of its queue stays queued, and goes
   * in when the user next writes to the session (`resume`) — nothing is
   * resumed at boot.
   */
  recover(): void {
    const { store } = this.deps;
    for (const rec of store.all()) {
      const id = rec.sessionId;
      if (rec.phase === 'discarded') {
        this.rollBack(rec, () => store.delete(id));
        continue;
      }
      if (rec.phase === 'failed' || rec.phase === 'ready') continue;
      if (rec.sessionStarted) {
        // Started before the stop, not yet marked: how long it took is lost with the stop.
        store.update(id, this.readyPatch(null));
        continue;
      }
      store.update(id, { phase: 'failed', message: INTERRUPTED_MESSAGE, errorId: null });
      // `made` is cleared only once the rollback is done: a restart before then rolls back again.
      this.rollBack(rec, () => store.update(id, { made: 'none' }));
    }
  }

  /** The server is closing: runs stop at their next step and leave their record to the next boot. */
  async close(): Promise<void> {
    this.closing = true;
    this.deps.store.wakeAll();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => { timer = setTimeout(resolve, this.closeWaitMs); }),
    ]);
    clearTimeout(timer);
    await Promise.all([...this.recovering.values(), ...this.cleanups]);
    this.deps.store.close();
  }

  /** Starts `work` as the session's one run; whatever it throws is recorded, never left unhandled. */
  private spawn(sessionId: string, work: (run: Run) => Promise<void>, failure: string): void {
    const run: Run = { cancelled: false, done: Promise.resolve() };
    this.runs.set(sessionId, run);
    run.done = work(run)
      .catch((err) => { this.recordError(sessionId, failure, err); })
      .finally(() => { if (this.runs.get(sessionId) === run) this.runs.delete(sessionId); });
  }

  /** The rollback a restart found owed, from the record; `then` once it is done. */
  private rollBack(rec: SetupRecord, then: () => void): void {
    const { path, branch, sessionId } = rec;
    if (rec.made === 'none' || !path || !branch) {
      then();
      return;
    }
    const rollback = this.deps.worktrees
      .rollbackInterrupted({ repoRoot: rec.repoRoot, path, branch, sessionId })
      .then(then)
      .catch((err) => { this.recordError(sessionId, 'A worktree setup could not be rolled back after a restart.', err); })
      .finally(() => this.recovering.delete(sessionId));
    this.recovering.set(sessionId, rollback);
  }

  /** Runs `work` as something closing waits for. */
  private critical<T>(work: () => Promise<T>): Promise<T> {
    const p = work();
    this.inFlight.add(p);
    const forget = () => { this.inFlight.delete(p); };
    p.then(forget, forget);
    return p;
  }

  /** `ready`, the first prompt gone into the session. `readyInMs` null when how long it took is not known. */
  private readyPatch(readyInMs: number | null): Partial<SetupRecord> {
    return { phase: 'ready', step: 3, made: 'none', readyInMs, prompt: '', attachments: [], message: null, errorId: null };
  }

  private async run(sessionId: string, run: Run, given?: LaunchCheck): Promise<void> {
    const { store, worktrees } = this.deps;
    const stopped = () => run.cancelled || this.closing;
    let rec = store.get(sessionId);
    if (!rec) return;
    let step: Step = rec.step;
    let branch = rec.branch;
    let made: { repoRoot: string; path: string; branch: string; added: boolean; sessionId: string } | null = null;
    // Closing leaves what was made to the record, which the next boot rolls back.
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
        rec = store.update(sessionId, { phase: 'checkout', step: 2, branch, title: named.title });
        if (!rec) return;
      }
      step = 2;

      // 2. The checkout.
      const path = worktrees.reserveLaunchDir(check, branch);
      made = { repoRoot: check.repoRoot, path, branch, added: false, sessionId };
      // Before git runs: a restart while it does finds out from git whether it got as far.
      store.update(sessionId, { path, made: 'worktree' });
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

      // The session, in the worktree. `sessionStarted` is written in the
      // same stretch closing waits for, so a close mid-start cannot lose it
      // and have the next boot roll back a worktree a session runs in.
      const starting = store.get(sessionId);
      if (!starting) return await undo();
      const kept = await this.critical(async () => {
        await this.deps.start(starting, worktrees.launchCwdOf(check, starting.launch.cwd, path));
        if (run.cancelled) return false;
        store.update(sessionId, { sessionStarted: true });
        return true;
      });
      if (!kept) {
        await this.deps.stop(sessionId);
        return await undo();
      }
      made = null;
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
   * The session has started: `ready` at once, with the queue kept. Then the
   * queued messages, oldest first, each once the session's turn has ended —
   * as if typed after its reply — and taken off the record only once the
   * session has it; one written meanwhile joins the end. A turn that ended
   * on the plan's limit hands them to its wait, which sends them at the
   * reset. A session ended or gone before its turn did gets none of them.
   */
  private async handOver(sessionId: string, run: Run): Promise<void> {
    const { store } = this.deps;
    const started = store.get(sessionId);
    if (!started) return;
    if (started.phase !== 'ready') store.update(sessionId, this.readyPatch(this.now() - started.startedAt));
    for (;;) {
      if (run.cancelled || this.closing) return;
      const rec = store.get(sessionId);
      if (!rec || rec.phase !== 'ready') return;
      const next = rec.queued[0];
      if (!next) return;
      const turn = this.deps.turnOf(sessionId);
      if (turn === 'running') {
        // No timer: the runner's turn and status edges wake it (`SetupStore.settled`).
        await store.untilSettled(sessionId);
        continue;
      }
      if (turn === 'gone') {
        // Not sent into a session the user ended: the log keeps their text.
        for (const message of rec.queued) {
          this.recordError(sessionId, 'A message written while the worktree was set up was not sent: the session ended first.',
            new Error('session ended'), { text: message.text });
        }
        store.update(sessionId, { queued: [] });
        return;
      }
      if (this.deps.toLimitWait(sessionId, next)) {
        store.update(sessionId, { queued: rec.queued.slice(1) });
        continue;
      }
      await this.critical(async () => {
        let outcome: DeliveryOutcome | null = null;
        try {
          outcome = await this.deps.deliver(sessionId, next);
        } catch (err) {
          // Not left at the head, where it would stop the rest: the log keeps its text.
          this.recordError(sessionId, 'A message written while the worktree was set up could not be sent.', err, { text: next.text });
        }
        if (outcome !== null && !startedTurn(outcome)) {
          this.recordError(sessionId, 'A message written while the worktree was set up could not be sent.',
            new Error(`delivery ended as ${outcome}`), { text: next.text });
        }
        // Taken off before anything else is looked at, closing included: a
        // restart from here on must not send it again.
        const now = store.get(sessionId);
        if (now) store.update(sessionId, { queued: now.queued.slice(1) });
      });
    }
  }

  /** Records a failure in the error log, and says it on the console when the log cannot take it. */
  private recordError(sessionId: string, message: string, err: unknown, context: Record<string, unknown> = {}): number | null {
    if (this.closing) {
      console.warn(`orbital: ${message}`, err);
      return null;
    }
    try {
      return this.deps.errors.record({
        source: 'server', kind: 'worktree_failed', sessionId, message,
        // `setup` tells the clients the session's setup block says it, even
        // one that has not seen the session's row yet.
        detail: err instanceof Error ? err.message : String(err), context: { ...context, setup: true },
      }).id;
    } catch (e) {
      console.warn(`orbital: ${message}`, err, e);
      return null;
    }
  }
}
