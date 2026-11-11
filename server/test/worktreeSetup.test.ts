import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { OrbitalDb } from '../src/db/database.js';
import { sessionSetups } from '../src/db/schema.js';
import type { DeliveryOutcome } from '../src/api/delivery.js';
import type { LaunchCheck } from '../src/worktree/service.js';
import { SetupService, SetupStore, firstPhaseOf, type SetupRecord, type SetupServiceDeps } from '../src/worktree/setup.js';
import { openTmpDb } from './tmp.js';

/**
 * The setup's runs against fake steps (spec
 * 2026-11-09-worktree-setup-in-background-design): what a run, the queue's
 * handover, a discard and a close leave in the `session_setups` row. The
 * real git and a real session are `worktreeEndToEnd.test.ts`'s.
 */

const ID = 'session-1';

const CHECK: LaunchCheck = { ok: true, repoRoot: '/repo', treeRoot: '/repo', commonDir: '/repo/.git', base: 'origin/main', branch: 'feat/x' };

function record(patch: Partial<SetupRecord> = {}): SetupRecord {
  const launch = { cwd: '/repo', base: 'origin/main', branch: 'feat/x', permissionMode: 'default' };
  return {
    sessionId: ID, ...firstPhaseOf(launch), path: null, repoRoot: '/repo', made: 'none', title: null,
    launch, prompt: 'go', attachments: [], mcpjson: null, queued: [], sessionStarted: false,
    message: null, errorId: null, startedAt: 0, readyInMs: null, ...patch,
  };
}

/** A promise and its resolver. */
function held<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type Worktrees = SetupServiceDeps['worktrees'];

/** A service over fake steps that succeed at once; `deps` and `steps` override any of them. */
function make(deps: Partial<SetupServiceDeps> = {}, db: OrbitalDb = openTmpDb('setup'), steps: Partial<Worktrees> = {}) {
  const store = new SetupStore(db);
  const errors = { record: vi.fn((_e: { message: string; context?: unknown }) => ({ id: 1 })) };
  const delivered: string[] = [];
  let turn: 'running' | 'over' | 'gone' = 'running';
  const worktrees = {
    checkLaunch: vi.fn(async () => CHECK),
    nameLaunchBranch: vi.fn(async () => ({ branch: 'feat/x', title: 'X' })),
    reserveLaunchDir: vi.fn(() => '/repo/.claude/worktrees/x'),
    addLaunchWorktree: vi.fn(async () => {}),
    copyLaunchFiles: vi.fn(async () => {}),
    launchCwdOf: vi.fn((_c: unknown, _cwd: string, path: string) => path),
    rollbackLaunch: vi.fn(async () => {}),
    rollbackInterrupted: vi.fn(async () => {}),
    ...steps,
  };
  const service = new SetupService({
    store, worktrees, errors: errors as any,
    start: async () => {},
    deliver: async (_id, message): Promise<DeliveryOutcome> => {
      delivered.push(message.text);
      turn = 'running';
      return 'sent';
    },
    turnOf: () => turn,
    toLimitWait: () => false,
    stop: async () => {},
    closeWaitMs: 2_000,
    ...deps,
  });
  const row = () => db.select().from(sessionSetups).where(eq(sessionSetups.sessionId, ID)).get();
  return {
    db, store, service, errors, worktrees, delivered, row,
    /** The session's turn ends, as the runner's edge says it. */
    endTurn: () => { turn = 'over'; store.settled(ID); },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('the queue after the session starts', () => {
  it('waits for the first turn to end without a timer, then goes in oldest first', async () => {
    const t = make();
    t.store.insert(record({ queued: [{ text: 'one' }, { text: 'two' }] }));
    t.service.begin(ID, CHECK);
    await vi.waitFor(() => expect(t.row()?.phase).toBe('ready'));
    // Nothing moves until the runner says the turn moved.
    await new Promise((r) => setTimeout(r, 50));
    expect(t.delivered).toEqual([]);
    t.endTurn();
    await vi.waitFor(() => expect(t.delivered).toEqual(['one']));
    expect(t.row()?.queued).toEqual([{ text: 'two' }]);
    t.endTurn();
    await vi.waitFor(() => expect(t.row()?.queued).toEqual([]));
    expect(t.delivered).toEqual(['one', 'two']);
  });

  it('hands the queue to a limit wait, in order, rather than into the limited session', async () => {
    const waited: string[] = [];
    const t = make({ toLimitWait: (_id, m) => { waited.push(m.text); return true; } });
    t.store.insert(record({ queued: [{ text: 'one' }, { text: 'two' }] }));
    t.service.begin(ID, CHECK);
    await vi.waitFor(() => expect(t.row()?.phase).toBe('ready'));
    t.endTurn();
    await vi.waitFor(() => expect(t.row()?.queued).toEqual([]));
    expect(waited).toEqual(['one', 'two']);
    expect(t.delivered).toEqual([]);
  });

  it('records a message the session did not take, rather than dropping it unsaid', async () => {
    const t = make({ deliver: async () => 'terminal' });
    t.store.insert(record({ queued: [{ text: 'lost' }] }));
    t.service.begin(ID, CHECK);
    await vi.waitFor(() => expect(t.row()?.phase).toBe('ready'));
    t.endTurn();
    await vi.waitFor(() => expect(t.row()?.queued).toEqual([]));
    expect(t.errors.record).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ text: 'lost' }) }));
  });

  it('takes a delivered message off the record even when the server closes during the delivery', async () => {
    const delivery = held<DeliveryOutcome>();
    const t = make({ deliver: () => delivery.promise });
    t.store.insert(record({ queued: [{ text: 'once' }, { text: 'later' }] }));
    t.service.begin(ID, CHECK);
    await vi.waitFor(() => expect(t.row()?.phase).toBe('ready'));
    t.endTurn();
    await new Promise((r) => setTimeout(r, 20));
    const closed = t.service.close();
    delivery.resolve('sent');
    await closed;
    expect(t.row()?.queued).toEqual([{ text: 'later' }]);
  });

  it('leaves a queue a restart found where it is until the user writes again', async () => {
    const db = openTmpDb('setup-boot');
    const first = make({}, db);
    first.store.insert(record({ phase: 'ready', step: 3, sessionStarted: true, queued: [{ text: 'left over' }] }));
    const t = make({}, db);
    t.endTurn();
    t.service.recover();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.delivered).toEqual([]);
    t.store.queue(ID, { text: 'new' });
    t.service.resume(ID);
    await vi.waitFor(() => expect(t.delivered).toEqual(['left over']));
    t.endTurn();
    await vi.waitFor(() => expect(t.delivered).toEqual(['left over', 'new']));
  });
});

describe('a server that closes or fails mid-setup', () => {
  it('records sessionStarted when the server closes while the session starts', async () => {
    const start = held();
    const t = make({ start: () => start.promise });
    t.store.insert(record());
    t.service.begin(ID, CHECK);
    await vi.waitFor(() => expect(t.row()?.phase).toBe('copy'));
    await new Promise((r) => setTimeout(r, 20));
    const closed = t.service.close();
    start.resolve();
    await closed;
    expect(t.row()?.sessionStarted).toBe(1);
  });

  it('marks a setup whose session the previous server held as started, so boot does not roll its worktree back', () => {
    const db = openTmpDb('setup-claim');
    make({}, db).store.insert(record({ phase: 'copy', step: 3, path: '/repo/.claude/worktrees/x', made: 'worktree' }));
    const t = make({}, db);
    t.store.claimedBeforeStop(ID);
    t.service.recover();
    expect(t.row()).toMatchObject({ phase: 'ready', made: 'none', sessionStarted: 1 });
    expect(t.worktrees.rollbackInterrupted).not.toHaveBeenCalled();
  });

  it('never leaves a rejection unhandled when the failure cannot be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = held<Awaited<ReturnType<SetupServiceDeps['worktrees']['checkLaunch']>>>();
    const t = make({ errors: { record: () => { throw new Error('SQLITE_FULL'); } } }, undefined, {
      checkLaunch: () => check.promise,
    });
    t.store.insert(record());
    t.service.begin(ID);
    // The db goes before the failure is written.
    t.db.$client.close();
    check.resolve({ ok: false, status: 500, error: 'worktree_failed', message: 'not a repository' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });

  it('keeps a discarded setup as a tombstone while its rollback is left to the next boot', async () => {
    const add = held();
    const db = openTmpDb('setup-tombstone');
    const t = make({}, db, { addLaunchWorktree: () => add.promise });
    t.store.insert(record());
    t.service.begin(ID, CHECK);
    await vi.waitFor(() => expect(t.row()?.made).toBe('worktree'));
    expect(t.service.discard(ID)).toBe(true);
    expect(t.store.setupOf(ID)).toBeNull();
    const closed = t.service.close();
    add.resolve();
    await closed;
    expect(t.row()).toMatchObject({ phase: 'discarded', made: 'worktree', path: '/repo/.claude/worktrees/x' });

    const next = make({}, db);
    next.service.recover();
    await vi.waitFor(() => expect(next.row()).toBeUndefined());
    expect(next.worktrees.rollbackInterrupted).toHaveBeenCalledWith(expect.objectContaining({ path: '/repo/.claude/worktrees/x', branch: 'feat/x' }));
  });

  it('rolls a discarded setup back and drops its tombstone while the server runs', async () => {
    const add = held();
    const t = make({}, undefined, { addLaunchWorktree: () => add.promise });
    t.store.insert(record());
    t.service.begin(ID, CHECK);
    await vi.waitFor(() => expect(t.row()?.made).toBe('worktree'));
    t.service.discard(ID);
    add.resolve();
    await vi.waitFor(() => expect(t.row()).toBeUndefined());
    expect(t.worktrees.rollbackLaunch).toHaveBeenCalledWith(expect.objectContaining({ path: '/repo/.claude/worktrees/x', added: true }));
  });

  it('clears what was made only once the boot rollback is done', async () => {
    const rollback = held();
    const db = openTmpDb('setup-recover');
    make({}, db).store.insert(record({ phase: 'checkout', step: 2, path: '/repo/.claude/worktrees/x', made: 'worktree' }));
    const t = make({}, db, { rollbackInterrupted: () => rollback.promise });
    t.service.recover();
    expect(t.row()).toMatchObject({ phase: 'failed', made: 'worktree' });
    rollback.resolve();
    await vi.waitFor(() => expect(t.row()?.made).toBe('none'));
  });
});
