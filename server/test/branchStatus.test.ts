import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ghAvailability,
  lookupPr,
  parseNumstat,
  parsePrView,
  readLines,
  resolveGh,
  type RunResult,
  type Runner,
} from '../src/git/branchStatus.js';

describe('parseNumstat', () => {
  it('sums added and removed, counting binary files as zero', () => {
    expect(parseNumstat(['3\t1\ta.ts', '-\t-\tlogo.png', '10\t0\tb.ts', ''].join('\0'))).toEqual({
      added: 13,
      removed: 1,
    });
  });

  it('reads a -z rename without mistaking its paths for records', () => {
    // A rename is `n\tm\t\0old\0new\0`; the new path here looks like a record.
    const out = '1\t0\t\0x y.txt\0' + '5\t5\tlooks-like-a-record\0' + '2\t2\tc.ts\0';
    expect(parseNumstat(out)).toEqual({ added: 3, removed: 2 });
  });

  it('keeps paths with tabs and spaces from breaking the count', () => {
    expect(parseNumstat('4\t2\tdir with space/t\tab.ts\0')).toEqual({ added: 4, removed: 2 });
  });

  it('reads the newline form, braces renames included', () => {
    const out = '1\t0\tsrc/{a => b}.ts\n-\t-\timg.png\n7\t3\t"q\\tuoted.ts"\n';
    expect(parseNumstat(out)).toEqual({ added: 8, removed: 3 });
  });

  it('is zero for no output', () => {
    expect(parseNumstat('')).toEqual({ added: 0, removed: 0 });
  });
});

const view = {
  number: 123,
  url: 'https://github.com/o/r/pull/123',
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  reviewDecision: 'APPROVED',
  statusCheckRollup: [] as unknown[],
};

describe('parsePrView', () => {
  it('tallies a rollup mixing check runs and status contexts', () => {
    const pr = parsePrView({
      ...view,
      statusCheckRollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
        // Not completed wins over a conclusion left over from an earlier run.
        { __typename: 'CheckRun', status: 'QUEUED', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'ERROR' },
        { __typename: 'StatusContext', state: 'PENDING' },
      ],
    });
    expect(pr).toEqual({
      number: 123,
      url: 'https://github.com/o/r/pull/123',
      state: 'open',
      review: 'approved',
      checks: { passed: 3, failed: 2, pending: 3 },
      base: 'main',
    });
  });

  it('reads a draft, which gh reports as an open PR', () => {
    expect(parsePrView({ ...view, isDraft: true })?.state).toBe('draft');
  });

  it('reads merged and closed', () => {
    expect(parsePrView({ ...view, state: 'MERGED' })?.state).toBe('merged');
    expect(parsePrView({ ...view, state: 'CLOSED' })?.state).toBe('closed');
  });

  it('has no checks for an empty or missing rollup, and no review for an empty decision', () => {
    const pr = parsePrView({ ...view, reviewDecision: '' });
    expect(pr?.checks).toBeNull();
    expect(pr?.review).toBeNull();
    const { statusCheckRollup: _, ...bare } = view;
    expect(parsePrView(bare)?.checks).toBeNull();
  });

  it('refuses JSON without what the header needs', () => {
    expect(parsePrView(null)).toBeNull();
    expect(parsePrView({ ...view, number: '123' })).toBeNull();
    expect(parsePrView({ ...view, state: 'WHATEVER' })).toBeNull();
    const { url: _, ...noUrl } = view;
    expect(parsePrView(noUrl)).toBeNull();
  });
});

function fakeRun(result: Partial<RunResult>): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (_file, args) => {
    calls.push(args);
    return { stdout: '', stderr: '', code: 1, timedOut: false, ...result };
  };
  return { run, calls };
}

const gh = () => '/opt/homebrew/bin/gh';

describe('lookupPr', () => {
  it('returns the PR gh printed', async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify(view) });
    const res = await lookupPr('/repo', 'feat/x', { run, resolve: gh });
    expect(res).toMatchObject({ kind: 'pr', pr: { number: 123, state: 'open' } });
    expect(calls[0].slice(0, 3)).toEqual(['pr', 'view', 'feat/x']);
  });

  it('is unavailable/missing when gh is not found, without spawning', async () => {
    const { run, calls } = fakeRun({});
    expect(await lookupPr('/repo', 'b', { run, resolve: () => null })).toEqual({
      kind: 'unavailable',
      reason: 'missing',
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['To get started with GitHub CLI, please run:  gh auth login', 'logged_out'],
    ['You are not logged into any GitHub hosts. Run gh auth login to authenticate.', 'logged_out'],
  ])('is unavailable/logged_out on %j', async (stderr) => {
    const { run } = fakeRun({ stderr });
    expect(await lookupPr('/repo', 'b', { run, resolve: gh })).toEqual({
      kind: 'unavailable',
      reason: 'logged_out',
    });
  });

  it.each([
    'no pull requests found for branch "feat/x"',
    'could not find any pull requests',
    'none of the git remotes configured for this repository point to a known GitHub host.',
  ])('is none on %j', async (stderr) => {
    const { run } = fakeRun({ stderr });
    expect(await lookupPr('/repo', 'b', { run, resolve: gh })).toEqual({ kind: 'none' });
  });

  it('fails on a timeout, an unknown error or output it cannot read', async () => {
    const cases: Partial<RunResult>[] = [
      { timedOut: true, code: null },
      { stderr: 'HTTP 502: Bad Gateway' },
      { code: 0, stdout: 'not json' },
      { code: 0, stdout: '{}' },
    ];
    for (const result of cases) {
      const { run } = fakeRun(result);
      expect(await lookupPr('/repo', 'b', { run, resolve: gh })).toEqual({ kind: 'failed' });
    }
  });
});

describe('ghAvailability', () => {
  it('maps a missing binary, a failing auth status and a passing one', async () => {
    expect(await ghAvailability({ resolve: () => null })).toBe('missing');
    expect(await ghAvailability({ run: fakeRun({ code: 1 }).run, resolve: gh })).toBe('logged_out');
    expect(await ghAvailability({ run: fakeRun({ code: 0 }).run, resolve: gh })).toBe('ready');
  });
});

describe('resolveGh', () => {
  it('prefers PATH, then falls back to the Homebrew locations', () => {
    const on = (...present: string[]) => (p: string) => present.includes(p);
    expect(resolveGh({ pathVar: '/a:/b', exists: on('/b/gh', '/opt/homebrew/bin/gh') })).toBe('/b/gh');
    expect(resolveGh({ pathVar: '/a', exists: on('/usr/local/bin/gh') })).toBe('/usr/local/bin/gh');
    expect(resolveGh({ pathVar: undefined, exists: on() })).toBeNull();
  });
});

describe('readLines', () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, encoding: 'utf8' },
    ).trim();
  const write = (path: string, content: string | Buffer) => writeFileSync(join(repo, path), content);
  const lines = (n: number, tag = 'l') =>
    Array.from({ length: n }, (_, i) => `${tag}${i}\n`).join('');

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'orbital-branch-'));
    git('init', '-q', '-b', 'main');
    write('a.txt', lines(10));
    git('add', '.');
    git('commit', '-qm', 'base');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('splits a feature branch into committed and uncommitted, untracked included', async () => {
    git('checkout', '-qb', 'feat');
    write('b.txt', lines(4)); // committed: +4
    git('add', '.');
    git('commit', '-qm', 'feat');
    // A commit on main after the fork must not count: the base is the merge base.
    git('checkout', '-q', 'main');
    write('main-only.txt', lines(50));
    git('add', '.');
    git('commit', '-qm', 'main moves on');
    git('checkout', '-q', 'feat');

    write('a.txt', lines(8) + 'changed\n'); // uncommitted: +1 −2
    write('new file.txt', 'one\ntwo\nthree'); // untracked: +3, last line unterminated
    write('blob.bin', Buffer.from([1, 0, 2, 10, 10])); // untracked binary: 0

    expect(await readLines(repo, 'main')).toEqual({
      parent: 'main',
      committed: { added: 4, removed: 0 },
      uncommitted: { added: 4, removed: 2 },
    });
  });

  it('counts only the uncommitted work without a parent', async () => {
    write('a.txt', lines(11));
    expect(await readLines(repo, null)).toEqual({
      parent: null,
      committed: { added: 0, removed: 0 },
      uncommitted: { added: 1, removed: 0 },
    });
  });

  it('treats a parent that does not resolve as no parent', async () => {
    git('checkout', '-qb', 'feat');
    write('b.txt', lines(2));
    git('add', '.');
    git('commit', '-qm', 'feat');
    expect(await readLines(repo, 'no-such-branch')).toEqual({
      parent: null,
      committed: { added: 0, removed: 0 },
      uncommitted: { added: 0, removed: 0 },
    });
  });

  it('falls back to origin/<parent> when the name has no local branch', async () => {
    git('update-ref', 'refs/remotes/origin/trunk', git('rev-parse', 'HEAD'));
    git('checkout', '-qb', 'feat');
    write('b.txt', lines(3));
    git('add', '.');
    git('commit', '-qm', 'feat');
    expect((await readLines(repo, 'trunk'))?.committed).toEqual({ added: 3, removed: 0 });
  });

  it('is null outside a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'orbital-plain-'));
    try {
      expect(await readLines(plain, 'main')).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
