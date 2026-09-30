import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitStore } from '../src/git/store.js';
import {
  BranchStatusStore,
  LINES_MAX_WAIT_MS,
  LINES_QUIET_MS,
  LINES_SETTING,
  PR_INTERVAL_MS,
  PR_SETTING,
} from '../src/git/branchStatusStore.js';
import type { BranchLines, BranchPr, PrLookup } from '../src/git/branchStatus.js';

const SHA = 'a'.repeat(40);

let dirs: string[] = [];
let git: GitStore;
let settings: Record<string, string>;

/** A repository on disk with `HEAD` as given and these local branches. */
function repo(head: string, branches: string[] = ['main']): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-branchstatus-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), head);
  for (const branch of branches) writeFileSync(join(dir, '.git', 'refs/heads', branch), `${SHA}\n`);
  return dir;
}

/** A linked worktree of `repoDir`, checked out on `branch`. */
function worktree(repoDir: string, branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-branchstatus-wt-'));
  dirs.push(dir);
  const gitDir = join(repoDir, '.git', 'worktrees', 'wt');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  writeFileSync(join(dir, '.git'), `gitdir: ${gitDir}\n`);
  return dir;
}

const LINES: BranchLines = {
  parent: 'main',
  committed: { added: 10, removed: 2 },
  uncommitted: { added: 1, removed: 0 },
};

function pr(overrides: Partial<BranchPr> = {}): BranchPr {
  return {
    number: 7, url: 'https://github.com/o/r/pull/7', state: 'open',
    review: null, checks: null, base: 'main', ...overrides,
  };
}

function makeStore(opts: {
  lines?: () => Promise<BranchLines | null>;
  lookup?: () => Promise<PrLookup>;
} = {}) {
  const readLines = vi.fn(async (_root: string, _parent: string | null) =>
    opts.lines ? opts.lines() : LINES,
  );
  const lookupPr = vi.fn(async (_root: string, _branch: string): Promise<PrLookup> =>
    opts.lookup ? opts.lookup() : { kind: 'none' },
  );
  const ghAvailability = vi.fn(async () => 'ready' as const);
  const store = new BranchStatusStore({
    git, settings: { get: (key) => settings[key] ?? '' }, readLines, lookupPr, ghAvailability,
  });
  const changes: string[] = [];
  store.on('change', (root: string) => changes.push(root));
  return { store, readLines, lookupPr, ghAvailability, changes };
}

beforeEach(() => {
  vi.useFakeTimers();
  git = new GitStore({ watch: false });
  settings = {};
});

afterEach(() => {
  vi.useRealTimers();
  git.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('BranchStatusStore gating', () => {
  it('reads nothing and keeps no timer with both settings off', async () => {
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature']);
    const { store, readLines, lookupPr } = makeStore();
    store.watchSession('s1', dir);
    git.applyIndexEvent(dir);
    git.applyHeadEvent(dir, 'change');
    store.transcriptActivity([dir]);
    store.refreshAll();
    await vi.advanceTimersByTimeAsync(PR_INTERVAL_MS * 2);
    expect(readLines).not.toHaveBeenCalled();
    expect(lookupPr).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.get(dir)).toBeUndefined();
    store.close();
  });

  it('reads nothing for a directory no window has open', async () => {
    settings = { [PR_SETTING]: 'true', [LINES_SETTING]: 'branch' };
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature']);
    const { store, readLines, lookupPr } = makeStore();
    git.locate(dir);
    store.transcriptActivity([dir]);
    git.applyIndexEvent(dir);
    await vi.advanceTimersByTimeAsync(LINES_MAX_WAIT_MS);
    expect(readLines).not.toHaveBeenCalled();
    expect(lookupPr).not.toHaveBeenCalled();
    store.close();
  });

  it('stops the PR interval when the last watched session goes, and keeps the cache', async () => {
    settings = { [PR_SETTING]: 'true', [LINES_SETTING]: 'branch' };
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature']);
    const { store, lookupPr } = makeStore({ lookup: async () => ({ kind: 'pr', pr: pr() }) });
    store.watchSession('s1', dir);
    await vi.advanceTimersByTimeAsync(0);
    expect(lookupPr).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PR_INTERVAL_MS);
    expect(lookupPr).toHaveBeenCalledTimes(2);
    store.unwatchSession('s1');
    await vi.advanceTimersByTimeAsync(PR_INTERVAL_MS * 3);
    expect(lookupPr).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.get(dir)?.pr?.number).toBe(7);
    store.close();
  });

  it('filters by the current settings, and a settings change republishes and starts reading', async () => {
    settings = { [LINES_SETTING]: 'split' };
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature']);
    const { store, lookupPr, changes } = makeStore({ lookup: async () => ({ kind: 'pr', pr: pr() }) });
    store.watchSession('s1', dir);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(dir)).toEqual({ lines: LINES });
    expect(lookupPr).not.toHaveBeenCalled();

    settings = { [LINES_SETTING]: 'split', [PR_SETTING]: 'true' };
    changes.length = 0;
    store.settingsChanged();
    expect(changes).toContain(dir);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(dir)?.pr?.number).toBe(7);

    settings = { [LINES_SETTING]: 'off', [PR_SETTING]: 'true' };
    store.settingsChanged();
    expect(store.get(dir)).toEqual({ pr: pr() });
    store.close();
  });
});

describe('BranchStatusStore lines debounce', () => {
  beforeEach(() => {
    settings = { [LINES_SETTING]: 'branch' };
  });

  it('recounts once after a quiet interval', async () => {
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature']);
    const { store, readLines } = makeStore();
    store.watchSession('s1', dir);
    await vi.advanceTimersByTimeAsync(0);
    expect(readLines).toHaveBeenCalledTimes(1);

    store.transcriptActivity([dir]);
    git.applyIndexEvent(dir);
    await vi.advanceTimersByTimeAsync(LINES_QUIET_MS - 1);
    expect(readLines).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readLines).toHaveBeenCalledTimes(2);
    store.close();
  });

  it('recounts at the maximum wait while triggers keep coming', async () => {
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature']);
    const { store, readLines } = makeStore();
    store.watchSession('s1', dir);
    await vi.advanceTimersByTimeAsync(0);
    readLines.mockClear();

    const step = LINES_QUIET_MS / 2;
    let elapsed = 0;
    store.transcriptActivity([dir]);
    while (elapsed + step < LINES_MAX_WAIT_MS) {
      await vi.advanceTimersByTimeAsync(step);
      elapsed += step;
      store.transcriptActivity([dir]);
    }
    expect(readLines).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LINES_MAX_WAIT_MS - elapsed);
    expect(readLines).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('keeps one read in flight and runs one more after it for triggers during it', async () => {
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature']);
    let release: () => void = () => {};
    const { store, readLines } = makeStore({
      lines: () => new Promise((resolve) => { release = () => resolve(LINES); }),
    });
    store.watchSession('s1', dir);
    expect(readLines).toHaveBeenCalledTimes(1);
    store.refreshAll();
    store.refreshAll();
    expect(readLines).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(readLines).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(readLines).toHaveBeenCalledTimes(2);
    store.close();
  });

  it('emits change only when the reading actually changed', async () => {
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature']);
    let reading = LINES;
    const { store, changes } = makeStore({ lines: async () => reading });
    store.watchSession('s1', dir);
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([dir]);
    store.refreshAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([dir]);
    reading = { ...LINES, uncommitted: { added: 5, removed: 0 } };
    store.refreshAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([dir, dir]);
    store.close();
  });
});

describe('BranchStatusStore parent selection', () => {
  async function parentFor(dir: string, opts: { pr?: BranchPr } = {}): Promise<string | null> {
    const { store, readLines } = makeStore({
      lookup: async () => (opts.pr ? { kind: 'pr', pr: opts.pr } : { kind: 'none' }),
    });
    store.watchSession('s1', dir);
    await vi.advanceTimersByTimeAsync(0);
    store.close();
    return readLines.mock.calls.at(-1)![1];
  }

  beforeEach(() => {
    settings = { [LINES_SETTING]: 'branch' };
  });

  it('has none on a detached HEAD', async () => {
    expect(await parentFor(repo(`${SHA}\n`))).toBeNull();
  });

  it('has none on the default branch', async () => {
    expect(await parentFor(repo('ref: refs/heads/main\n'))).toBeNull();
  });

  it('has none in a worktree checked out on the default branch', async () => {
    const main = repo('ref: refs/heads/other\n', ['main', 'other']);
    expect(await parentFor(worktree(main, 'main'))).toBeNull();
  });

  it('takes the default branch on any other branch', async () => {
    expect(await parentFor(repo('ref: refs/heads/feature\n', ['main', 'feature']))).toBe('main');
  });

  it('has none when the default branch cannot be resolved', async () => {
    expect(await parentFor(repo('ref: refs/heads/feature\n', ['feature', 'trunk']))).toBeNull();
  });

  it("takes the PR's base when the PR setting is on, and recounts when it arrives", async () => {
    settings = { [LINES_SETTING]: 'branch', [PR_SETTING]: 'true' };
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature', 'release']);
    const { store, readLines } = makeStore({
      lookup: async () => ({ kind: 'pr', pr: pr({ base: 'release' }) }),
    });
    store.watchSession('s1', dir);
    await vi.advanceTimersByTimeAsync(0);
    expect(readLines.mock.calls.map((call) => call[1])).toEqual(['main', 'release']);
    store.close();
  });

  it("ignores a cached PR's base once the PR setting is off", async () => {
    settings = { [LINES_SETTING]: 'branch', [PR_SETTING]: 'true' };
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature', 'release']);
    const { store, readLines } = makeStore({
      lookup: async () => ({ kind: 'pr', pr: pr({ base: 'release' }) }),
    });
    store.watchSession('s1', dir);
    await vi.advanceTimersByTimeAsync(0);
    settings = { [LINES_SETTING]: 'branch' };
    store.settingsChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(readLines.mock.calls.at(-1)![1]).toBe('main');
    store.close();
  });
});

describe('BranchStatusStore PR lookups', () => {
  beforeEach(() => {
    settings = { [PR_SETTING]: 'true' };
  });

  it('keeps the last good PR on a failed lookup, and clears it on none and unavailable', async () => {
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature']);
    let next: PrLookup = { kind: 'pr', pr: pr() };
    const { store } = makeStore({ lookup: async () => next });
    store.watchSession('s1', dir);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(dir)?.pr?.number).toBe(7);

    next = { kind: 'failed' };
    store.refreshAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(dir)?.pr?.number).toBe(7);

    next = { kind: 'none' };
    store.refreshAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(dir)).toBeUndefined();

    next = { kind: 'pr', pr: pr() };
    store.refreshAll();
    await vi.advanceTimersByTimeAsync(0);
    next = { kind: 'unavailable', reason: 'logged_out' };
    store.refreshAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(dir)).toBeUndefined();
    store.close();
  });

  it('never looks up on the default branch, and drops the PR on switching to it', async () => {
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature']);
    const { store, lookupPr } = makeStore({ lookup: async () => ({ kind: 'pr', pr: pr() }) });
    store.watchSession('s1', dir);
    await vi.advanceTimersByTimeAsync(0);
    expect(lookupPr).toHaveBeenCalledWith(dir, 'feature');

    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    git.applyHeadEvent(dir, 'change');
    await vi.advanceTimersByTimeAsync(PR_INTERVAL_MS);
    expect(lookupPr).toHaveBeenCalledTimes(1);
    expect(store.get(dir)).toBeUndefined();
    store.close();
  });

  it('looks up again on a branch switch, but not on a commit or on transcript activity', async () => {
    const dir = repo('ref: refs/heads/feature\n', ['main', 'feature', 'other']);
    const { store, lookupPr } = makeStore();
    store.watchSession('s1', dir);
    await vi.advanceTimersByTimeAsync(0);
    expect(lookupPr).toHaveBeenCalledTimes(1);

    git.applyHeadEvent(dir, 'change');
    store.transcriptActivity([dir]);
    git.applyIndexEvent(dir);
    await vi.advanceTimersByTimeAsync(LINES_MAX_WAIT_MS);
    expect(lookupPr).toHaveBeenCalledTimes(1);

    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    git.applyHeadEvent(dir, 'change');
    await vi.advanceTimersByTimeAsync(0);
    expect(lookupPr).toHaveBeenLastCalledWith(dir, 'other');
    store.close();
  });
});
