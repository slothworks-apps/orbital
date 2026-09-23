import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultBranchOf,
  locateGit,
  parseHead,
  resolveGitDirs,
} from '../src/git/gitState.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbital-git-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A main working tree: `.git` is a directory holding its own HEAD. */
function mainCheckout(root: string, head: string): string {
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), head);
  return root;
}

/** A linked worktree: `.git` is a file pointing into the repository's. */
function linkedWorktree(repo: string, name: string, head: string): string {
  const gitDir = join(repo, '.git', 'worktrees', name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), head);
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  const tree = join(repo, '.worktrees', name);
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, '.git'), `gitdir: ${gitDir}\n`);
  return tree;
}

describe('parseHead', () => {
  it('reads a branch out of a symbolic ref', () => {
    expect(parseHead('ref: refs/heads/feat/desktop-tray\n')).toEqual({
      ref: 'feat/desktop-tray',
      detached: false,
    });
  });

  it('abbreviates a detached HEAD to seven characters', () => {
    expect(parseHead('7dd49384f1c0b2a6e5d4c3b2a1908f7e6d5c4b3a\n')).toEqual({
      ref: '7dd4938',
      detached: true,
    });
  });

  it('refuses a HEAD in neither shape rather than guessing', () => {
    // Half-written during a checkout, or a file that is not a HEAD at all.
    expect(parseHead('ref:')).toBeNull();
    expect(parseHead('7dd4938')).toBeNull();
    expect(parseHead('')).toBeNull();
    expect(parseHead(null)).toBeNull();
  });
});

describe('resolveGitDirs', () => {
  it('finds the working tree from a directory nested inside it', () => {
    const root = mainCheckout(dir, 'ref: refs/heads/main\n');
    mkdirSync(join(root, 'server', 'src', 'git'), { recursive: true });
    const dirs = resolveGitDirs(join(root, 'server', 'src', 'git'));
    expect(dirs).toMatchObject({ root, worktree: false });
    expect(dirs?.commonDir).toBe(join(root, '.git'));
  });

  it('reads a worktree through its gitdir file, without climbing to the repo', () => {
    mainCheckout(dir, 'ref: refs/heads/main\n');
    const tree = linkedWorktree(dir, 'tray-mode', 'ref: refs/heads/tray-mode\n');
    const dirs = resolveGitDirs(tree);
    expect(dirs).toMatchObject({ root: tree, worktree: true });
    expect(dirs?.gitDir).toBe(join(dir, '.git', 'worktrees', 'tray-mode'));
    expect(dirs?.commonDir).toBe(join(dir, '.git'));
  });

  it('follows a relative gitdir, which a hand-written one can be', () => {
    mainCheckout(dir, 'ref: refs/heads/main\n');
    const gitDir = join(dir, '.git', 'worktrees', 'rel');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/rel\n');
    const tree = join(dir, 'trees', 'rel');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, '.git'), 'gitdir: ../../.git/worktrees/rel\n');
    expect(resolveGitDirs(tree)?.gitDir).toBe(gitDir);
  });

  it('returns null for a directory with no repository above it', () => {
    const outside = join(dir, 'notes');
    mkdirSync(outside);
    expect(resolveGitDirs(outside)).toBeNull();
  });
});

describe('defaultBranchOf', () => {
  it('takes the name from origin/HEAD', () => {
    const gitDir = join(dir, '.git');
    mkdirSync(join(gitDir, 'refs', 'remotes', 'origin'), { recursive: true });
    writeFileSync(join(gitDir, 'refs/remotes/origin/HEAD'), 'ref: refs/remotes/origin/trunk\n');
    expect(defaultBranchOf(gitDir)).toBe('trunk');
  });

  it('recovers the name from packed-refs, where the symref is only a sha', () => {
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    const sha = 'a'.repeat(40);
    writeFileSync(
      join(gitDir, 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/remotes/origin/HEAD\n${sha} refs/remotes/origin/develop\n${'b'.repeat(40)} refs/remotes/origin/feature\n`,
    );
    expect(defaultBranchOf(gitDir)).toBe('develop');
  });

  it('falls back to main, then master, by name', () => {
    const gitDir = join(dir, '.git');
    mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(gitDir, 'refs/heads/master'), `${'c'.repeat(40)}\n`);
    expect(defaultBranchOf(gitDir)).toBe('master');
    writeFileSync(join(gitDir, 'refs/heads/main'), `${'d'.repeat(40)}\n`);
    expect(defaultBranchOf(gitDir)).toBe('main');
  });

  it('gives up when there is no remote and no conventionally named branch', () => {
    const gitDir = join(dir, '.git');
    mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(gitDir, 'refs/heads/trunk'), `${'e'.repeat(40)}\n`);
    expect(defaultBranchOf(gitDir)).toBeNull();
  });
});

describe('locateGit', () => {
  it('marks the default branch of a main checkout', () => {
    const root = mainCheckout(dir, 'ref: refs/heads/main\n');
    writeFileSync(join(root, '.git', 'refs/heads/main'), `${'f'.repeat(40)}\n`);
    expect(locateGit(root)?.location).toEqual({
      ref: 'main',
      detached: false,
      worktree: false,
      defaultBranch: true,
    });
  });

  it('does not mark a feature branch', () => {
    const root = mainCheckout(dir, 'ref: refs/heads/feat/desktop-tray\n');
    writeFileSync(join(root, '.git', 'refs/heads/main'), `${'f'.repeat(40)}\n`);
    expect(locateGit(root)?.location).toMatchObject({
      ref: 'feat/desktop-tray',
      defaultBranch: false,
    });
  });

  it('never marks a worktree as the default branch, whatever it is on', () => {
    mainCheckout(dir, 'ref: refs/heads/main\n');
    writeFileSync(join(dir, '.git', 'refs/heads/main'), `${'f'.repeat(40)}\n`);
    const tree = linkedWorktree(dir, 'main-copy', 'ref: refs/heads/main\n');
    expect(locateGit(tree)?.location).toEqual({
      ref: 'main',
      detached: false,
      worktree: true,
      defaultBranch: false,
    });
  });

  it('reports a detached HEAD without a default-branch claim', () => {
    const root = mainCheckout(dir, `${'7dd4938'}${'0'.repeat(33)}\n`);
    expect(locateGit(root)?.location).toEqual({
      ref: '7dd4938',
      detached: true,
      worktree: false,
      defaultBranch: false,
    });
  });

  it('treats a malformed HEAD as no reading at all', () => {
    const root = mainCheckout(dir, 'ref:\n');
    expect(locateGit(root)).toBeNull();
  });
});
