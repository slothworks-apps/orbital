/**
 * Work in a worktree (spec 2026-11-02-work-in-a-worktree-design; adr
 * orbital-makes-the-worktree-and-names-its-branch): what New Session's
 * WORKTREE group reads, the worktree a launch makes before the session
 * starts, and the state its removal is offered from.
 *
 * Nothing about a worktree is stored but the user's *Keep*: the rest is read
 * from git and from where the live sessions work, each time it is asked.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { sessionColumns, sessions } from '../db/schema.js';
import { defaultBranchOf, parseHead, readGitLocation, resolveGitDirs, type GitDirs } from '../git/gitState.js';
import { sourceOf, statusOf, type ShapeContext } from '../api/shape.js';
import { effectiveTagIds } from '../tags/rules.js';
import type { SessionRow } from '../types.js';
import type { WorkingTrees } from '../git/workingTrees.js';
import { GitCommands, WORKTREES_DIR, readMergeBaseSync } from './git.js';
import {
  MAX_BRANCH_CHARS, branchForm, branchNameProblem, fallbackBranch, isFallbackBranch, leafOf, withSuffix,
} from './naming.js';
import { worktreeChoice, type WorktreeVariant } from './variant.js';

/** Settings › Sessions: turn the switch on when another session works in the checkout. On unless `'false'`. */
export const WORKTREE_AUTO_ON_KEY = 'worktree_auto_on_when_occupied';

/** Settings › Sessions: gitignore-style patterns, one per line, of more files to copy into a new worktree. */
export const WORKTREE_COPY_PATTERNS_KEY = 'worktree_copy_patterns';

/** The worktree paths whose strip the user dismissed, as a JSON array. */
export const WORKTREE_DISMISSED_KEY = 'worktree_dismissed';

/** Local files git does not track that every new worktree gets a copy of. */
export const ALWAYS_COPIED = ['CLAUDE.local.md', '.claude/settings.local.json'];

export type WorktreeOptions =
  | { git: false }
  | {
      git: true;
      repoRoot: string;
      treeRoot: string;
      defaultBranch: string;
      currentBranch: string | null;
      occupants: { sessionId: string; title: string; tagId: string | null; branch: string | null }[];
      branchForm: string;
      branches: { local: string[]; remote: string[] };
      fetchedAt: number | null;
      autoOn: boolean;
    };

export type WorktreeFetchResult =
  | { ok: true; fetchedAt: number }
  | { ok: false; error: 'offline' | 'auth' | 'other'; message: string };

export interface WorktreeState {
  path: string;
  leaf: string;
  branch: string | null;
  pr: { number: number; state: 'open' | 'draft' | 'merged' | 'closed' } | null;
  pushed: boolean;
  uncommittedFiles: number;
  unpushedCommits: number;
  sharedWith: string[];
  variant: WorktreeVariant;
  removable: boolean;
  endsSession: boolean;
  dismissed: boolean;
}

export type LaunchRefusal = {
  ok: false;
  status: 400 | 409 | 500;
  error: 'worktree_invalid_branch' | 'worktree_branch_exists' | 'worktree_failed';
  message: string;
};

export interface LaunchPrep {
  ok: true;
  /** Where the session starts: the worktree, or the dialog's subdirectory inside it. */
  cwd: string;
  path: string;
  branch: string;
  /** The session's name from the naming call, when it made one. */
  title: string | null;
  /** Takes the worktree and its fresh branch away again, for a launch that failed after this. */
  rollback(): Promise<void>;
}

/** What the removal refused, as the route answers it. */
export type RemoveRefusal = 'not_worktree' | 'worktree_shared' | 'worktree_live_terminal' | 'worktree_dirty';

/** The branch naming call, injected so tests need no model. */
export type BranchNamer = (input: {
  sessionId: string; prompt: string; recentNames: readonly string[];
  /** The Claude directory the session will run under, whose account the call goes through. */
  claudeDirId?: number;
}) => Promise<{ branch: string; title: string | null } | null>;

export interface WorktreeServiceDeps {
  ctx: ShapeContext;
  /** Where each session works now; absent, every session works in its home. */
  trees?: Pick<WorkingTrees, 'workingDir' | 'otherTrees'>;
  settings: { get(key: string): string; set(key: string, value: string): void };
  nameBranch?: BranchNamer;
  commands?: GitCommands;
}

/** A directory's linked-worktree reading, or null when it is in the main checkout or no repository. */
export interface LinkedWorktree {
  dirs: GitDirs;
  branch: string | null;
}

/** The tree a directory sits in, read fresh: a removed worktree must not answer from a cache. */
export function linkedWorktreeOf(dir: string): LinkedWorktree | null {
  const dirs = resolveGitDirs(dir);
  if (!dirs?.worktree || !existsSync(dirs.root)) return null;
  let head: string;
  try {
    head = readFileSync(join(dirs.gitDir, 'HEAD'), 'utf8');
  } catch {
    return null;
  }
  const parsed = parseHead(head);
  return { dirs, branch: parsed && !parsed.detached ? parsed.ref : null };
}

/**
 * What the session's appendix says about its worktree (spec § What the
 * session is told), or null outside one. The PR target is the branch's
 * `gh-merge-base`, else the repository's default branch.
 */
export function worktreeContextOf(dir: string): { path: string; branch: string; prTarget: string; temporary: boolean } | null {
  const tree = linkedWorktreeOf(dir);
  if (!tree?.branch) return null;
  const prTarget = readMergeBaseSync(tree.dirs.root, tree.branch) ?? defaultBranchOf(tree.dirs.commonDir) ?? 'main';
  return { path: tree.dirs.root, branch: tree.branch, prTarget, temporary: isFallbackBranch(tree.branch) };
}

/** `dir` is `root` or lies under it. */
function within(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A base without its remote: what `gh-merge-base` and the PR name. */
function stripOrigin(base: string): string {
  return base.startsWith('origin/') ? base.slice('origin/'.length) : base;
}

/** The path with symlinks resolved, or the path itself when it does not exist. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export class WorktreeService {
  private readonly cmd: GitCommands;
  /** When Orbital last fetched each repository in this process, by its shared git dir. */
  private fetched = new Map<string, number>();

  constructor(private readonly deps: WorktreeServiceDeps) {
    this.cmd = deps.commands ?? new GitCommands();
  }

  // -------------------------------------------------------------------------
  // Who works where

  /**
   * The live sessions — any status but `ended`, terminal ones too — with the
   * trees they and their running subagents work in.
   */
  private liveSessions(): { row: SessionRow; roots: string[] }[] {
    const { ctx } = this.deps;
    const held = [...new Set([...ctx.registry.all().map((l) => l.sessionId), ...ctx.runner.active()])];
    const rows = ctx.db.select(sessionColumns).from(sessions)
      .where(or(
        and(eq(sessions.source, 'web'), isNull(sessions.endedAt)),
        held.length ? inArray(sessions.id, held) : undefined,
      ))
      .all() as SessionRow[];
    const out: { row: SessionRow; roots: string[] }[] = [];
    for (const row of rows) {
      if (row.purpose === 'harness_draft') continue;
      if (statusOf(ctx, row) === 'ended') continue;
      const workingDir = this.deps.trees?.workingDir(row) ?? row.cwd;
      const others = this.deps.trees?.otherTrees(row, workingDir, ctx.subagents.all(row.id)) ?? [];
      const roots = [workingDir, ...others.map((t) => t.root)].map((d) => ctx.git.rootOf(d) ?? d);
      out.push({ row, roots });
    }
    return out;
  }

  /** The live sessions working in the tree rooted at `treeRoot`, at its root or below. */
  private occupantsOf(treeRoot: string): SessionRow[] {
    // Through realpath: a session started in `/tmp/x` records `/private/tmp/x`, and a
    // symlinked directory names the same tree by two paths.
    const tree = realPath(treeRoot);
    return this.liveSessions().filter(({ roots }) => roots.some((r) => realPath(r) === tree)).map(({ row }) => row);
  }

  // -------------------------------------------------------------------------
  // The dialog

  async options(cwd: string): Promise<WorktreeOptions> {
    const dirs = resolveGitDirs(cwd);
    if (!dirs) return { git: false };
    const location = readGitLocation(dirs);
    const repoRoot = await this.cmd.mainCheckoutOf(dirs.root, dirs.commonDir);
    const branches = await this.cmd.branches(dirs.root);
    const currentBranch = location && !location.detached ? location.ref : null;
    const occupants = this.occupantsOf(dirs.root).map((row) => {
      const tagIds = effectiveTagIds(this.deps.ctx.db, row.id);
      return {
        sessionId: row.id, title: row.title,
        tagId: tagIds.length ? String(tagIds[0]) : null,
        branch: currentBranch,
      };
    });
    const recent = [...branches.local, ...branches.remote.map(stripOrigin)];
    return {
      git: true,
      repoRoot,
      treeRoot: dirs.root,
      defaultBranch: defaultBranchOf(dirs.commonDir) ?? currentBranch ?? 'main',
      currentBranch,
      occupants,
      branchForm: branchForm([...new Set(recent)]),
      branches,
      fetchedAt: this.fetched.get(dirs.commonDir) ?? null,
      autoOn: this.deps.settings.get(WORKTREE_AUTO_ON_KEY) !== 'false' && occupants.length > 0,
    };
  }

  async fetch(cwd: string): Promise<WorktreeFetchResult | null> {
    const dirs = resolveGitDirs(cwd);
    if (!dirs) return null;
    const res = await this.cmd.fetchOrigin(dirs.root);
    if (!res.ok) return res;
    const fetchedAt = Date.now();
    this.fetched.set(dirs.commonDir, fetchedAt);
    return { ok: true, fetchedAt };
  }

  // -------------------------------------------------------------------------
  // Launch

  /**
   * Steps 1–5 of the spec's Launch, ready for the session to start in.
   * Anything that fails after the worktree exists takes it away again.
   */
  async prepareLaunch(input: {
    cwd: string; base: string; branch?: string; prompt: string; sessionId: string; claudeDirId?: number;
  }): Promise<LaunchPrep | LaunchRefusal> {
    const failed = (message: string): LaunchRefusal => ({ ok: false, status: 500, error: 'worktree_failed', message });
    const dirs = resolveGitDirs(input.cwd);
    if (!dirs) return failed(`${input.cwd} is not in a git repository.`);
    const repoRoot = await this.cmd.mainCheckoutOf(dirs.root, dirs.commonDir);
    const base = input.base.trim();
    if (!base || base.startsWith('-') || !(await this.cmd.resolves(repoRoot, base))) {
      return failed(`The base ${base || '(empty)'} is not a branch or commit of this repository.`);
    }

    // 1. The branch.
    let branch: string;
    let title: string | null = null;
    const typed = input.branch?.trim();
    if (typed) {
      const problem = branchNameProblem(typed);
      if (problem || !(await this.cmd.validBranchName(repoRoot, typed))) {
        return { ok: false, status: 400, error: 'worktree_invalid_branch', message: problem ?? `${typed} is not a valid branch name.` };
      }
      if (await this.cmd.branchExists(repoRoot, typed)) {
        return { ok: false, status: 409, error: 'worktree_branch_exists', message: `${typed} already exists.` };
      }
      branch = typed;
    } else {
      const branches = await this.cmd.branches(repoRoot);
      const taken = new Set([...branches.local, ...branches.remote.map(stripOrigin)]);
      const named = await this.deps.nameBranch?.({
        sessionId: input.sessionId, prompt: input.prompt, recentNames: [...taken], claudeDirId: input.claudeDirId,
      }) ?? null;
      let candidate = named && (await this.cmd.validBranchName(repoRoot, named.branch)) ? named.branch : null;
      if (candidate) title = named!.title;
      candidate ??= fallbackBranch(input.sessionId);
      // A name taken since the list was read is caught by `worktree add` below.
      const free = withSuffix(candidate, (n) => taken.has(n), MAX_BRANCH_CHARS)
        ?? withSuffix(fallbackBranch(input.sessionId), (n) => taken.has(n), MAX_BRANCH_CHARS);
      if (!free) return failed('No free branch name was found.');
      branch = free;
    }

    // 2. The worktree.
    const worktreesDir = join(repoRoot, WORKTREES_DIR);
    const leaf = withSuffix(leafOf(branch), (n) => existsSync(join(worktreesDir, n)));
    if (!leaf) return failed(`No free directory for the worktree was found in ${worktreesDir}.`);
    const path = join(worktreesDir, leaf);
    let added = false;
    // The path did not exist before this launch, so whatever is there now is the launch's own.
    const rollback = async () => {
      if (added || existsSync(path)) await this.cmd.removeWorktree(repoRoot, path, true);
      rmSync(path, { recursive: true, force: true });
      await this.cmd.git(repoRoot, ['worktree', 'prune']);
      if (added) await this.cmd.deleteBranch(repoRoot, branch);
    };
    try {
      mkdirSync(worktreesDir, { recursive: true });
      const add = await this.cmd.addWorktree(repoRoot, path, branch, base);
      if (add.code !== 0) {
        await rollback();
        if (/already exists/i.test(add.stderr) && !existsSync(path)) {
          return { ok: false, status: 409, error: 'worktree_branch_exists', message: `${branch} already exists.` };
        }
        return failed(add.stderr.trim() || 'git worktree add failed.');
      }
      added = true;

      // 3. The PR target, when the base is not the default branch.
      const defaultBranch = defaultBranchOf(dirs.commonDir);
      const target = stripOrigin(base);
      if (target !== defaultBranch) {
        const set = await this.cmd.setMergeBase(path, branch, target);
        if (set.code !== 0) throw new Error(set.stderr.trim() || 'git config gh-merge-base failed.');
      }

      // 4. The local files git does not track. A missing one is skipped.
      await this.copyLocalFiles(repoRoot, path);

      // 5. The worktrees out of the main checkout's `git status`.
      const rel = `${WORKTREES_DIR}/${leaf}`;
      if (!(await this.cmd.ignored(repoRoot, rel))) {
        const exclude = join(dirs.commonDir, 'info', 'exclude');
        mkdirSync(dirname(exclude), { recursive: true });
        const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
        appendFileSync(exclude, `${current === '' || current.endsWith('\n') ? '' : '\n'}/${WORKTREES_DIR}/\n`);
      }
    } catch (err) {
      await rollback();
      return failed(err instanceof Error ? err.message : String(err));
    }

    // 6. The same subdirectory inside the worktree, where it exists there.
    const sub = relative(dirs.root, input.cwd);
    const inside = sub && !sub.startsWith('..') ? join(path, sub) : path;
    const cwd = statSync(inside, { throwIfNoEntry: false })?.isDirectory() ? inside : path;
    return { ok: true, cwd, path, branch, title, rollback };
  }

  /** `ALWAYS_COPIED` and whatever matches `worktree_copy_patterns`, from the main checkout. */
  private async copyLocalFiles(repoRoot: string, path: string): Promise<void> {
    const patterns = this.deps.settings.get(WORKTREE_COPY_PATTERNS_KEY)
      .split('\n').map((p) => p.trim()).filter((p) => p !== '' && !p.startsWith('#'));
    const matched = await this.cmd.untrackedMatching(repoRoot, patterns);
    const files = new Set([...ALWAYS_COPIED, ...matched.filter((f) => !f.startsWith(`${WORKTREES_DIR}/`))]);
    for (const file of files) {
      const from = join(repoRoot, file);
      const to = join(path, file);
      if (!within(to, path)) continue;
      try {
        if (!statSync(from, { throwIfNoEntry: false })?.isFile() || existsSync(to)) continue;
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      } catch {
        // Unreadable or gone between the listing and the copy: skipped, as a missing one is.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Removal

  /** The worktree the session works in now, or null when it does not work in one. */
  linkedTreeOf(row: SessionRow): LinkedWorktree | null {
    return linkedWorktreeOf(this.deps.trees?.workingDir(row) ?? row.cwd);
  }

  async state(row: SessionRow): Promise<WorktreeState | null> {
    const tree = this.linkedTreeOf(row);
    if (!tree) return null;
    const { ctx } = this.deps;
    const path = tree.dirs.root;
    const [uncommitted, upstream] = await Promise.all([this.cmd.uncommittedFiles(path), this.cmd.upstream(path)]);
    if (uncommitted === null) return null;
    const pushed = upstream !== null || (tree.branch !== null && (await this.remoteHas(path, tree.branch)));
    const unpushed = (await this.cmd.unpushedCommits(path, upstream !== null)) ?? 0;
    const sharedWith = this.occupantsOf(path).map((r) => r.id).filter((id) => id !== row.id);
    const choice = worktreeChoice({
      uncommittedFiles: uncommitted, unpushedCommits: unpushed, sharedWith,
      ended: statusOf(ctx, row) === 'ended', orbital: sourceOf(ctx, row) === 'web',
    });
    const pr = ctx.branchStatus.get(path)?.pr;
    return {
      path, leaf: basename(path), branch: tree.branch,
      pr: pr ? { number: pr.number, state: pr.state } : null,
      pushed,
      uncommittedFiles: uncommitted,
      unpushedCommits: unpushed,
      sharedWith,
      ...choice,
      dismissed: this.dismissed().includes(path),
    };
  }

  private async remoteHas(root: string, branch: string): Promise<boolean> {
    const res = await this.cmd.git(root, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    return res.code === 0;
  }

  /**
   * Removes the session's worktree: ends the session first when it has not
   * ended, never deletes the branch. Refuses what the variant rules out.
   */
  async remove(
    row: SessionRow, force: boolean, endSession: (id: string) => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; error: RemoveRefusal } | { ok: false; error: 'worktree_failed'; message: string }> {
    const state = await this.state(row);
    if (!state) return { ok: false, error: 'not_worktree' };
    const refusal = this.refusalOf(state, force);
    if (refusal) return { ok: false, error: refusal };
    if (state.endsSession) await endSession(row.id);
    return this.removePath(state.path, force);
  }

  /** Why removing would be refused, or null when it may go ahead. */
  refusalOf(state: WorktreeState, force: boolean): RemoveRefusal | null {
    if (state.variant === 'c3') return 'worktree_shared';
    if (!state.removable) return 'worktree_live_terminal';
    if (state.uncommittedFiles > 0 && !force) return 'worktree_dirty';
    return null;
  }

  /** `git worktree remove [--force]`, run from the main checkout. */
  async removePath(path: string, force: boolean): Promise<{ ok: true } | { ok: false; error: 'worktree_failed'; message: string }> {
    const dirs = resolveGitDirs(path);
    const repoRoot = dirs ? await this.cmd.mainCheckoutOf(dirs.root, dirs.commonDir) : dirname(path);
    const res = await this.cmd.removeWorktree(repoRoot, path, force);
    if (res.code !== 0) return { ok: false, error: 'worktree_failed', message: res.stderr.trim() || 'git worktree remove failed.' };
    this.undismiss(path);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Keep

  private dismissed(): string[] {
    try {
      const parsed: unknown = JSON.parse(this.deps.settings.get(WORKTREE_DISMISSED_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
    } catch {
      return [];
    }
  }

  /** *Keep*: the strip stays hidden for this worktree. Paths that are gone are dropped on the way. */
  dismiss(path: string): void {
    const kept = this.dismissed().filter((p) => p !== path && existsSync(p));
    this.deps.settings.set(WORKTREE_DISMISSED_KEY, JSON.stringify([...kept, path]));
  }

  private undismiss(path: string): void {
    const list = this.dismissed();
    if (list.includes(path)) this.deps.settings.set(WORKTREE_DISMISSED_KEY, JSON.stringify(list.filter((p) => p !== path)));
  }
}
