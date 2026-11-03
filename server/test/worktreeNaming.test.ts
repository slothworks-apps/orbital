import { describe, it, expect, vi } from 'vitest';
import {
  BRANCH_FORM_SAMPLES, DEFAULT_BRANCH_FORM, MAX_BRANCH_CHARS, branchForm, branchNameProblem, fallbackBranch,
  isFallbackBranch, nameBranch, parseBranchReply, withSuffix, type BranchNamingFailure,
} from '../src/worktree/naming.js';
import { leafOf } from '@orbital/shared/worktree';
import { classifyFetchError } from '../src/worktree/git.js';
import { parseGitConfigValue } from '../src/git/gitState.js';

describe('branch form', () => {
  it('is the most common prefix, the most recent winning a tie', () => {
    expect(branchForm(['fix/a', 'feat/b', 'feat/c', 'fix/d', 'main'])).toBe('fix/');
    expect(branchForm(['feat/a', 'feat/b', 'fix/c'])).toBe('feat/');
  });

  it('ignores names without a slash and the temporary names', () => {
    expect(branchForm(['main', 'develop'])).toBe(DEFAULT_BRANCH_FORM);
    expect(branchForm(['claude/1234abcd', 'claude/5678abcd', 'docs/x'])).toBe('docs/');
    expect(branchForm([])).toBe(DEFAULT_BRANCH_FORM);
  });

  it('reads only the most recent names', () => {
    const recent = Array.from({ length: BRANCH_FORM_SAMPLES }, (_, i) => `fix/${i}`);
    expect(branchForm([...recent, ...Array.from({ length: BRANCH_FORM_SAMPLES * 2 }, (_, i) => `feat/${i}`)])).toBe('fix/');
  });
});

describe('branch names', () => {
  it('finds the problems a user is likely to trip over', () => {
    expect(branchNameProblem('feat/tray flicker')).toMatch(/spaces/);
    expect(branchNameProblem('x'.repeat(MAX_BRANCH_CHARS + 1))).not.toBeNull();
    for (const bad of ['-x', 'a..b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a/', '/a', 'a//b', 'a.', 'a.lock', 'a/.b', '@', 'a@{b', '']) {
      expect(branchNameProblem(bad), bad).not.toBeNull();
    }
    for (const good of ['feat/tray-flicker', 'fix/a.b', 'x', 'release/v1.2']) expect(branchNameProblem(good), good).toBeNull();
  });

  it('adds -2, -3 to a name that is taken, within the length limit', () => {
    const taken = new Set(['feat/x', 'feat/x-2']);
    expect(withSuffix('feat/y', (n) => taken.has(n))).toBe('feat/y');
    expect(withSuffix('feat/x', (n) => taken.has(n))).toBe('feat/x-3');
    const long = `feat/${'a'.repeat(MAX_BRANCH_CHARS - 5)}`;
    const next = withSuffix(long, (n) => n === long, MAX_BRANCH_CHARS)!;
    expect(next.length).toBeLessThanOrEqual(MAX_BRANCH_CHARS);
    expect(next.endsWith('-2')).toBe(true);
    expect(withSuffix('a', () => true)).toBeNull();
  });

  it('names the temporary branch after the session and knows it again', () => {
    const name = fallbackBranch('0123abcd-ffff-4fff-8fff-ffffffffffff');
    expect(name).toBe('claude/0123abcd');
    expect(isFallbackBranch(name)).toBe(true);
    expect(isFallbackBranch(`${name}-2`)).toBe(true);
    expect(isFallbackBranch('claude/fix-the-zoom')).toBe(false);
    expect(isFallbackBranch('feat/0123abcd')).toBe(false);
  });

  it('takes the leaf from the last segment', () => {
    expect(leafOf('feat/tray-flicker')).toBe('tray-flicker');
    expect(leafOf('x')).toBe('x');
  });
});

describe('the naming reply', () => {
  it('reads a branch and a title', () => {
    expect(parseBranchReply('feat/map-zoom\nMap zoom fix')).toEqual({ branch: 'feat/map-zoom', title: 'Map zoom fix' });
    expect(parseBranchReply('1. `fix/tray`\n2. Tray flicker')).toEqual({ branch: 'fix/tray', title: 'Tray flicker' });
    expect(parseBranchReply('fix/tray')).toEqual({ branch: 'fix/tray', title: null });
  });

  it('refuses what is not a branch name, or more than was asked', () => {
    expect(parseBranchReply('Sure! Here is a name\nfeat/x\nTitle')).toBeNull();
    expect(parseBranchReply('feat/map zoom\nMap zoom')).toBeNull();
    expect(parseBranchReply('')).toBeNull();
  });

  const reply = (text: string) => vi.fn(() => (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    yield { type: 'result' };
  })());

  it('asks once and returns the parsed reply', async () => {
    const queryFn = reply('feat/map-zoom\nMap zoom fix');
    const named = await nameBranch({ queryFn, maxPromptChars: 4000 }, { prompt: 'zoom is broken', recentNames: ['feat/a'] });
    expect(named).toEqual({ branch: 'feat/map-zoom', title: 'Map zoom fix' });
    const [args] = queryFn.mock.calls[0] as unknown as [{ prompt: string; options: Record<string, unknown> }];
    expect(args.prompt).toContain('feat/a');
    expect(args.options.maxTurns).toBe(1);
  });

  it('gives up on no prompt, a failure, and a call that does not answer in time, recording the failures', async () => {
    const failures: BranchNamingFailure[] = [];
    const onFailure = (f: BranchNamingFailure) => failures.push(f);
    expect(await nameBranch({ queryFn: reply('feat/x'), maxPromptChars: 4000, onFailure }, { prompt: '  ', recentNames: [] })).toBeNull();
    expect(failures).toEqual([]);
    const failing = vi.fn(() => { throw new Error('spawn ENOENT'); });
    expect(await nameBranch({ queryFn: failing as any, maxPromptChars: 4000, onFailure }, { prompt: 'x', recentNames: [] })).toBeNull();
    const hanging = vi.fn(() => (async function* () { await new Promise(() => {}); })());
    expect(await nameBranch({ queryFn: hanging as any, maxPromptChars: 4000, timeoutMs: 10, onFailure }, { prompt: 'x', recentNames: [] })).toBeNull();
    expect(await nameBranch({ queryFn: reply('Sure! here you go\nfeat/x\nT'), maxPromptChars: 4000, onFailure }, { prompt: 'x', recentNames: [] })).toBeNull();
    expect(failures.map((f) => f.reason)).toEqual(['error', 'timeout', 'unparsable']);
    expect(failures[0].message).toContain('spawn ENOENT');
  });

  it('still falls back when the failure cannot be recorded', async () => {
    const failing = vi.fn(() => { throw new Error('boom'); });
    const onFailure = () => { throw new Error('db gone'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await nameBranch({ queryFn: failing as any, maxPromptChars: 4000, onFailure }, { prompt: 'x', recentNames: [] })).toBeNull();
    warn.mockRestore();
  });
});

describe('fetch errors', () => {
  it('tells offline from a login problem', () => {
    expect(classifyFetchError("fatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com")).toBe('offline');
    expect(classifyFetchError('ssh: connect to host github.com port 22: Network is unreachable')).toBe('offline');
    expect(classifyFetchError('git@github.com: Permission denied (publickey).')).toBe('auth');
    expect(classifyFetchError("fatal: unable to access 'https://github.com/x/y/': The requested URL returned error: 403")).toBe('auth');
    expect(classifyFetchError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe('auth');
    expect(classifyFetchError("fatal: 'origin' does not appear to be a git repository")).toBe('other');
  });
});

describe('git config values', () => {
  const config = [
    '[core]',
    '\tbare = false',
    '[branch "feat/old-2"]',
    '\tgh-merge-base = fix/stack',
    '[branch "Feat/Case"]',
    '\tGH-Merge-Base = "quoted value" ; a comment',
    '[Branch "feat/x"] gh-merge-base = inline',
    '[branch.legacy]',
    '\tgh-merge-base = old-form',
    '[branch "feat/old-2"]',
    '\tgh-merge-base = develop # later wins',
    '[branch "feat/cont"]',
    '\tgh-merge-base = a\\',
    'b',
    '[branch "feat/flag"]',
    '\tgh-merge-base',
  ].join('\n');

  it('reads the last value of a branch key, as git would', () => {
    expect(parseGitConfigValue(config, 'branch', 'feat/old-2', 'gh-merge-base')).toBe('develop');
    expect(parseGitConfigValue(config, 'branch', 'Feat/Case', 'gh-merge-base')).toBe('quoted value');
    expect(parseGitConfigValue(config, 'branch', 'feat/case', 'gh-merge-base')).toBeNull();
    expect(parseGitConfigValue(config, 'branch', 'feat/x', 'gh-merge-base')).toBe('inline');
    expect(parseGitConfigValue(config, 'branch', 'legacy', 'gh-merge-base')).toBe('old-form');
    expect(parseGitConfigValue(config, 'branch', 'feat/cont', 'gh-merge-base')).toBe('ab');
    expect(parseGitConfigValue(config, 'branch', 'feat/flag', 'gh-merge-base')).toBe('true');
    expect(parseGitConfigValue(config, 'branch', 'nope', 'gh-merge-base')).toBeNull();
    expect(parseGitConfigValue(config, 'core', '', 'bare')).toBeNull();
  });
});
