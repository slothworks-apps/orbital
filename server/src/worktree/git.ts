/**
 * The git commands behind Work in a worktree (spec
 * 2026-11-02-work-in-a-worktree-design): reading a repository's branches,
 * fetching, adding and removing worktrees, and the counts the removal choice
 * is made from. Spawned like the branch status readings, without a shell.
 */

import { execFileSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { execRunner, type RunResult, type Runner } from '../git/branchStatus.js';

/** How long one local `git` command may take. */
const GIT_TIMEOUT_MS = 15_000;

/** How long `git fetch origin` may take; it goes to the network. */
export const FETCH_TIMEOUT_MS = 60_000;

/** How long `git worktree add` may take: it checks out a whole tree. */
const WORKTREE_ADD_TIMEOUT_MS = 120_000;

/** How long the appendix's synchronous read of a config value may block a start. */
const CONFIG_READ_TIMEOUT_MS = 2_000;

/** How many branches of each kind the dialog's search gets. */
export const BRANCH_LIST_MAX = 200;

/** Where Orbital puts the worktrees it makes, relative to the main checkout. */
export const WORKTREES_DIR = '.claude/worktrees';

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  // Never wait on a prompt nobody can answer.
  GIT_TERMINAL_PROMPT: '0',
  // An ssh remote asks no passphrase either; one already configured stays.
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
});

export class GitCommands {
  constructor(private readonly run: Runner = execRunner) {}

  git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<RunResult> {
    return this.run('git', args, { cwd, env: env(), timeout });
  }

  /** The main checkout's root, from any tree of the repository. */
  async mainCheckoutOf(treeRoot: string, commonDir: string): Promise<string> {
    if (basename(commonDir) === '.git') return dirname(commonDir);
    // A repository whose git dir lives elsewhere: the first tree git lists is the main one.
    const res = await this.git(treeRoot, ['worktree', 'list', '--porcelain']);
    const first = res.code === 0 ? /^worktree (.+)$/m.exec(res.stdout)?.[1] : undefined;
    return first ?? treeRoot;
  }

  /** Local branches and `origin/…` branches, each most recently committed first. */
  async branches(cwd: string): Promise<{ local: string[]; remote: string[] }> {
    const res = await this.git(cwd, [
      'for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin',
    ]);
    const local: string[] = [];
    const remote: string[] = [];
    if (res.code !== 0) return { local, remote };
    for (const ref of res.stdout.split('\n')) {
      if (ref.startsWith('refs/heads/')) {
        if (local.length < BRANCH_LIST_MAX) local.push(ref.slice('refs/heads/'.length));
      } else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') {
        if (remote.length < BRANCH_LIST_MAX) remote.push(`origin/${ref.slice('refs/remotes/origin/'.length)}`);
      }
    }
    return { local, remote };
  }

  /** Whether a branch of that name exists locally or on `origin`. */
  async branchExists(cwd: string, name: string): Promise<boolean> {
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
      const res = await this.git(cwd, ['show-ref', '--verify', '--quiet', ref]);
      if (res.code === 0) return true;
    }
    return false;
  }

  /** git's own verdict on a branch name. */
  async validBranchName(cwd: string, name: string): Promise<boolean> {
    const res = await this.git(cwd, ['check-ref-format', '--branch', name]);
    return res.code === 0;
  }

  /** Whether `rev` names a commit. */
  async resolves(cwd: string, rev: string): Promise<boolean> {
    const res = await this.git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
    return res.code === 0;
  }

  async fetchOrigin(cwd: string): Promise<{ ok: true } | { ok: false; error: 'offline' | 'auth' | 'other'; message: string }> {
    const res = await this.git(cwd, ['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
    if (res.code === 0) return { ok: true };
    const message = (res.stderr.trim() || (res.timedOut ? 'git fetch timed out' : 'git fetch failed')).slice(0, 2000);
    return { ok: false, error: res.timedOut ? 'offline' : classifyFetchError(res.stderr), message };
  }

  /** `git worktree add -b <branch> <path> <base>`, never tracking the base. */
  async addWorktree(repoRoot: string, path: string, branch: string, base: string): Promise<RunResult> {
    // `--no-track`: a branch started from `origin/main` would otherwise take
    // it as its upstream, and read as pushed before it ever was.
    return this.git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, path, base], WORKTREE_ADD_TIMEOUT_MS);
  }

  async removeWorktree(repoRoot: string, path: string, force: boolean): Promise<RunResult> {
    return this.git(repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
  }

  async deleteBranch(repoRoot: string, branch: string): Promise<void> {
    await this.git(repoRoot, ['branch', '-D', '--end-of-options', branch]);
  }

  async setMergeBase(cwd: string, branch: string, target: string): Promise<RunResult> {
    return this.git(cwd, ['config', `branch.${branch}.gh-merge-base`, target]);
  }

  /** Whether the checkout's ignore rules already cover this path. */
  async ignored(repoRoot: string, relPath: string): Promise<boolean> {
    const res = await this.git(repoRoot, ['check-ignore', '--quiet', '--no-index', relPath]);
    return res.code === 0;
  }

  /** Untracked files matching gitignore-style patterns, relative to `root`. */
  async untrackedMatching(root: string, patterns: readonly string[]): Promise<string[]> {
    if (patterns.length === 0) return [];
    const res = await this.git(root, [
      'ls-files', '-z', '--others', '--ignored', ...patterns.map((p) => `--exclude=${p}`),
    ]);
    if (res.code !== 0) return [];
    return res.stdout.split('\0').filter(Boolean);
  }

  /** Changed and untracked entries, as `git status --porcelain` lists them. */
  async uncommittedFiles(root: string): Promise<number | null> {
    const res = await this.git(root, ['status', '--porcelain']);
    if (res.code !== 0) return null;
    return res.stdout.split('\n').filter((l) => l.trim() !== '').length;
  }

  /** The branch's upstream, or null when it has none. */
  async upstream(root: string): Promise<string | null> {
    const res = await this.git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null;
  }

  /**
   * Commits only this tree has: ahead of the upstream, or without one, on no
   * remote branch at all.
   */
  async unpushedCommits(root: string, hasUpstream: boolean): Promise<number | null> {
    const args = hasUpstream ? ['rev-list', '--count', '@{u}..HEAD'] : ['rev-list', '--count', 'HEAD', '--not', '--remotes'];
    const res = await this.git(root, args);
    if (res.code !== 0) return null;
    const n = Number(res.stdout.trim());
    return Number.isFinite(n) ? n : null;
  }
}

/** Why `git fetch` failed, in the dialog's three words. */
export function classifyFetchError(stderr: string): 'offline' | 'auth' | 'other' {
  // First: a refused login also reads "unable to access".
  if (/authentication failed|permission denied|could not read (?:username|password)|terminal prompts disabled|access denied|returned error: 40[13]|host key verification failed/i.test(stderr)) {
    return 'auth';
  }
  if (/could not resolve host|network is unreachable|connection (?:timed out|refused)|operation timed out|no route to host|temporary failure in name resolution|could not connect/i.test(stderr)) {
    return 'offline';
  }
  return 'other';
}

/**
 * `branch.<name>.gh-merge-base`, read synchronously: the appendix is
 * composed inside a start that does not wait. Null when it is not set.
 */
export function readMergeBaseSync(root: string, branch: string): string | null {
  try {
    const out = execFileSync('git', ['config', '--get', `branch.${branch}.gh-merge-base`], {
      cwd: root, encoding: 'utf8', timeout: CONFIG_READ_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], env: env(),
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}
