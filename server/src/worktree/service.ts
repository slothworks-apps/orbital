/**
 * Work in a worktree (spec 2026-11-02-work-in-a-worktree-design; adr
 * orbital-makes-the-worktree-and-names-its-branch): what New Session's
 * WORKTREE group reads, the worktree a launch makes before the session
 * starts, and the state its removal is offered from.
 *
 * Nothing about a worktree is stored but the user's *Keep*: the rest is read
 * from git and from where the live sessions work, each time it is asked.
 */

import { appendFileSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  WORKTREES_DIR, leafOf, stripOrigin, worktreeChoice,
  type WorktreeFetchResult, type WorktreeLaunchError, type WorktreeOptions, type WorktreeRemoveRefusal, type WorktreeState,
} from '@orbital/shared/worktree';
import { sessionColumns, sessions } from '../db/schema.js';
import { defaultBranchOf, readBranchConfig, readGitLocation, resolveGitDirs, type GitDirs } from '../git/gitState.js';
import { sourceOf, statusOf, type ShapeContext } from '../api/shape.js';
import { isWithin } from '../files/preview.js';
import { effectiveTagIds } from '../tags/rules.js';
import type { ErrorLog } from '../errors/log.js';
import type { WorktreeContext } from '../runner/sessionInstructions.js';
import type { SessionRow } from '../types.js';
import type { WorkingTrees } from '../git/workingTrees.js';
import { GitCommands } from './git.js';
import {
  MAX_BRANCH_CHARS, branchForm, branchNameProblem, fallbackBranch, isFallbackBranch, withSuffix,
} from './naming.js';

export type { WorktreeFetchResult, WorktreeOptions, WorktreeState } from '@orbital/shared/worktree';

/** Settings › Sessions: turn the switch on when another session works in the checkout. On unless `'false'`. */
export const WORKTREE_AUTO_ON_KEY = 'worktree_auto_on_when_occupied';

/** Settings › Sessions: gitignore-style patterns, one per line, of more files to copy into a new worktree. */
export const WORKTREE_COPY_PATTERNS_KEY = 'worktree_copy_patterns';

/** The worktree paths whose strip the user dismissed, as a JSON array. */
export const WORKTREE_DISMISSED_KEY = 'worktree_dismissed';

/** Local files git does not track that every new worktree gets a copy of. */
export const ALWAYS_COPIED = ['CLAUDE.local.md', '.claude/settings.local.json'];

export type LaunchRefusal = {
  ok: false;
  status: 400 | 409 | 500;
  error: WorktreeLaunchError;
  message: string;
};

/** What `checkLaunch` found: the launch may go ahead. */
export interface LaunchCheck {
  ok: true;
  /** The main checkout the worktree is made from. */
  repoRoot: string;
  /** The root of the tree the dialog's directory is in. */
  treeRoot: string;
  commonDir: string;
  base: string;
  /** The branch the user typed, valid and free when checked. */
  branch: string | null;
}

/** `git worktree add` refused: nothing was added. */
export class WorktreeAddError extends Error {}

/**
 * What a removal came to. `ended` says whether the session was ended on
 * the way, whatever became of the worktree; a refusal ends nothing unless
 * the caller asked for the end in any case (End's `endSession: 'always'`).
 */
export type RemoveResult = { ended: boolean } & (
  | { ok: true }
  | { ok: false; error: WorktreeRemoveRefusal }
  | { ok: false; error: 'worktree_failed'; message: string }
);

export interface RemoveOptions {
  /** `--force`: uncommitted files are discarded. */
  force: boolean;
  /** The path the user confirmed; another worktree now is `worktree_state_changed`. */
  path?: string;
  /**
   * Whether the user confirmed ending the session — it must match the
   * state's `endsSession`, else `worktree_state_changed` — or `'always'`:
   * End, which ends the session whatever becomes of the worktree.
   */
  endSession: boolean | 'always';
  /** Ends the session, and without `stoppedLater` waits for its process to be gone. */
  end: (id: string) => Promise<void>;
  /**
   * End's: the answer does not wait for git. Once the checks pass and the
   * session has ended, this waits for its process and git removes the tree
   * on its own; what git refuses is recorded, as any removal's.
   */
  stoppedLater?: (id: string) => Promise<void>;
}

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
  /** Where a removal or a rollback that failed is recorded. */
  errors?: Pick<ErrorLog, 'record'>;
  /**
   * Whether the session is a worktree launch whose worktree is not ready:
   * it works nowhere yet, so it occupies no checkout and has no worktree.
   */
  inSetup?: (sessionId: string) => boolean;
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
  const location = readGitLocation(dirs);
  if (!location) return null;
  return { dirs, branch: location.detached ? null : location.ref };
}

/**
 * What the session's appendix says about its worktree (spec § What the
 * session is told), or null outside one. The PR target is the branch's
 * `gh-merge-base`, read from the config file: this runs at every start.
 */
export function worktreeContextOf(dir: string): WorktreeContext | null {
  const tree = linkedWorktreeOf(dir);
  if (!tree?.branch) return null;
  return {
    path: tree.dirs.root,
    branch: tree.branch,
    prTarget: readBranchConfig(tree.dirs, tree.branch, 'gh-merge-base'),
    temporary: isFallbackBranch(tree.branch),
  };
}

/**
 * Makes `<parent>/<name>`, or `<name>-2`, `<name>-3` and so on, whichever
 * `mkdir` gets first, and returns its path: a name another launch made in
 * the meantime is skipped rather than shared. Null when every suffix is
 * taken; any failure but a taken name throws.
 */
function reserveDir(parent: string, name: string): string | null {
  let reserved: string | null = null;
  withSuffix(name, (candidate) => {
    try {
      mkdirSync(join(parent, candidate));
      reserved = join(parent, candidate);
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return true;
      throw err;
    }
  });
  return reserved;
}

/**
 * Makes `rel`'s directories under `root` one at a time, refusing a part
 * that exists as anything but a real directory — a symlink above all, which
 * would carry the copy out of the tree. False when it refused.
 */
function makeDirsInside(root: string, rel: string): boolean {
  let at = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    if (part === '..') return false;
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (!st) mkdirSync(at);
    else if (!st.isDirectory()) return false;
  }
  return true;
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
  /** The removals End left running, by worktree path. */
  private removing = new Map<string, Promise<void>>();

  constructor(private readonly deps: WorktreeServiceDeps) {
    this.cmd = deps.commands ?? new GitCommands();
  }

  // -------------------------------------------------------------------------
  // Who works where

  /**
   * The live Orbital sessions — any status but `ended` — with the trees they
   * and their running subagents work in. Terminal sessions do not count:
   * Orbital shows them but does not drive them (spec § States), nor do
   * sessions still in setup: their directory is only where the dialog was.
   */
  private liveSessions(): { row: SessionRow; roots: string[] }[] {
    const { ctx } = this.deps;
    const running = ctx.runner.active();
    const rows = ctx.db.select(sessionColumns).from(sessions)
      .where(and(
        eq(sessions.source, 'web'),
        running.length ? or(isNull(sessions.endedAt), inArray(sessions.id, running)) : isNull(sessions.endedAt),
      ))
      .all() as SessionRow[];
    const out: { row: SessionRow; roots: string[] }[] = [];
    for (const row of rows) {
      if (row.purpose === 'harness_draft' || this.deps.inSetup?.(row.id)) continue;
      if (sourceOf(ctx, row) !== 'web' || statusOf(ctx, row) === 'ended') continue;
      const workingDir = this.deps.trees?.workingDir(row) ?? row.cwd;
      const others = this.deps.trees?.otherTrees(row, workingDir, ctx.subagents.all(row.id)) ?? [];
      const roots = [workingDir, ...others.map((t) => t.root)].map((d) => ctx.git.rootOf(d) ?? d);
      out.push({ row, roots });
    }
    return out;
  }

  /** The live Orbital sessions working in the tree rooted at `treeRoot`, at its root or below. */
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
  //
  // The spec's Launch, in the steps setup runs them in the background (spec
  // 2026-11-09-worktree-setup-in-background-design): `checkLaunch` answers
  // before the session exists, the rest run after it. A step that fails
  // throws; what it made is taken away by `rollbackLaunch`.

  /**
   * What the launch can be refused for before anything is made: not a
   * repository, a base that does not resolve, a typed branch that is not a
   * valid name or already exists.
   */
  async checkLaunch(input: { cwd: string; base: string; branch?: string }): Promise<LaunchCheck | LaunchRefusal> {
    const failed = (message: string): LaunchRefusal => ({ ok: false, status: 500, error: 'worktree_failed', message });
    const dirs = resolveGitDirs(input.cwd);
    if (!dirs) return failed(`${input.cwd} is not in a git repository.`);
    const repoRoot = await this.cmd.mainCheckoutOf(dirs.root, dirs.commonDir);
    const base = input.base.trim();
    if (!base || base.startsWith('-') || !(await this.cmd.resolves(repoRoot, base))) {
      return failed(`The base ${base || '(empty)'} is not a branch or commit of this repository.`);
    }
    const typed = input.branch?.trim();
    if (typed) {
      const problem = branchNameProblem(typed);
      if (problem || !(await this.cmd.validBranchName(repoRoot, typed))) {
        return { ok: false, status: 400, error: 'worktree_invalid_branch', message: problem ?? `${typed} is not a valid branch name.` };
      }
      if (await this.cmd.branchExists(repoRoot, typed)) {
        return { ok: false, status: 409, error: 'worktree_branch_exists', message: `${typed} already exists.` };
      }
    }
    return { ok: true, repoRoot, treeRoot: dirs.root, commonDir: dirs.commonDir, base, branch: typed || null };
  }

  /**
   * Step 1: a free branch name from the naming call, or the temporary name
   * when it gives none. A name taken since the list was read is caught by
   * `worktree add`.
   */
  async nameLaunchBranch(
    check: Pick<LaunchCheck, 'repoRoot'>,
    input: { prompt: string; sessionId: string; claudeDirId?: number },
  ): Promise<{ branch: string; title: string | null }> {
    const { repoRoot } = check;
    const branches = await this.cmd.branches(repoRoot);
    const taken = new Set([...branches.local, ...branches.remote.map(stripOrigin)]);
    const named = await this.deps.nameBranch?.({
      sessionId: input.sessionId, prompt: input.prompt, recentNames: [...taken], claudeDirId: input.claudeDirId,
    }) ?? null;
    let candidate = named && (await this.cmd.validBranchName(repoRoot, named.branch)) ? named.branch : null;
    const title = candidate ? named!.title : null;
    candidate ??= fallbackBranch(input.sessionId);
    const free = withSuffix(candidate, (n) => taken.has(n), MAX_BRANCH_CHARS)
      ?? withSuffix(fallbackBranch(input.sessionId), (n) => taken.has(n), MAX_BRANCH_CHARS);
    if (!free) throw new Error('No free branch name was found.');
    return { branch: free, title };
  }

  /**
   * Step 2's start: the worktree's directory, reserved by a `mkdir` that
   * fails when the name is taken, so two launches never settle on the same
   * one and the rollback only ever takes away what this launch made; git
   * adds a worktree into an empty directory that exists.
   */
  reserveLaunchDir(check: Pick<LaunchCheck, 'repoRoot'>, branch: string): string {
    const worktreesDir = join(check.repoRoot, WORKTREES_DIR);
    mkdirSync(worktreesDir, { recursive: true });
    const reserved = reserveDir(worktreesDir, leafOf(branch));
    if (!reserved) throw new Error(`No free directory for the worktree was found in ${worktreesDir}.`);
    return reserved;
  }

  /**
   * The rest of step 2: `git worktree add` into the reserved directory, then
   * the PR target when the base is not the default branch. Throws
   * `WorktreeAddError` when git did not add the worktree.
   */
  async addLaunchWorktree(check: LaunchCheck, path: string, branch: string): Promise<void> {
    const add = await this.cmd.addWorktree(check.repoRoot, path, branch, check.base);
    if (add.code !== 0) throw new WorktreeAddError(add.stderr.trim() || 'git worktree add failed.');
    const target = stripOrigin(check.base);
    if (target !== defaultBranchOf(check.commonDir)) {
      const set = await this.cmd.setMergeBase(path, branch, target);
      if (set.code !== 0) throw new Error(set.stderr.trim() || 'git config gh-merge-base failed.');
    }
  }

  /**
   * Step 3: the local files git does not track, a missing one skipped, then
   * the worktrees out of the main checkout's `git status`.
   */
  async copyLaunchFiles(check: LaunchCheck, path: string): Promise<void> {
    await this.copyLocalFiles(check.repoRoot, path);
    const rel = `${WORKTREES_DIR}/${basename(path)}`;
    if (!(await this.cmd.ignored(check.repoRoot, rel))) {
      const exclude = join(check.commonDir, 'info', 'exclude');
      mkdirSync(dirname(exclude), { recursive: true });
      const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      appendFileSync(exclude, `${current === '' || current.endsWith('\n') ? '' : '\n'}/${WORKTREES_DIR}/\n`);
    }
  }

  /** Where the session starts: the dialog's subdirectory inside the worktree, where it exists there. */
  launchCwdOf(check: Pick<LaunchCheck, 'treeRoot'>, cwd: string, path: string): string {
    const sub = relative(check.treeRoot, cwd);
    const inside = sub && !sub.startsWith('..') ? join(path, sub) : path;
    return statSync(inside, { throwIfNoEntry: false })?.isDirectory() ? inside : path;
  }

  /**
   * Undoes what a setup the server stopped during had made, from its record
   * alone: whether `git worktree add` got as far as registering the
   * directory is read from git, so its branch is deleted only when it was.
   */
  async rollbackInterrupted(made: { repoRoot: string; path: string; branch: string; sessionId: string }): Promise<void> {
    const list = await this.cmd.git(made.repoRoot, ['worktree', 'list', '--porcelain']).catch(() => null);
    const added = !!list && list.code === 0 && list.stdout.split('\n').some((l) => l === `worktree ${made.path}`);
    await this.rollbackLaunch({ ...made, added });
  }

  /**
   * Undoes a launch's step 2 onwards: the worktree it added, the directory
   * it reserved, and the branch `worktree add -b` made. Only those: the
   * directory was reserved by this launch and the branch was new. Every
   * step runs whatever the one before came to; what fails is recorded, and
   * nothing here throws over the launch's own error.
   */
  async rollbackLaunch(made: { repoRoot: string; path: string; branch: string; added: boolean; sessionId: string }): Promise<void> {
    const { repoRoot, path, branch, added } = made;
    const problems: string[] = [];
    const step = async (what: string, run: () => Promise<{ code: number | null; stderr: string }> | void) => {
      try {
        const res = await run();
        if (res && res.code !== 0) problems.push(`${what}: ${res.stderr.trim() || `exit ${res.code}`}`);
      } catch (err) {
        problems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (added) await step('git worktree remove', () => this.cmd.removeWorktree(repoRoot, path, true));
    await step('remove the directory', () => rmSync(path, { recursive: true, force: true }));
    await step('git worktree prune', () => this.cmd.git(repoRoot, ['worktree', 'prune']));
    if (added) await step('git branch -D', () => this.cmd.deleteBranch(repoRoot, branch));
    if (problems.length) {
      this.record(`A failed worktree launch could not be fully undone: ${path}`, problems.join('\n'), {
        repoRoot, path, branch,
      }, made.sessionId);
    }
  }

  /** Records a worktree failure in the error log (adr errors-are-recorded-not-announced). */
  private record(message: string, detail: string | null, context: Record<string, unknown>, sessionId: string | null): void {
    try {
      this.deps.errors?.record({ source: 'server', kind: 'worktree_failed', message, detail, context, sessionId });
    } catch (err) {
      console.warn('orbital: could not record a worktree failure:', err);
    }
  }

  /**
   * `ALWAYS_COPIED` and whatever matches `worktree_copy_patterns`, from the
   * main checkout. Only into the worktree: a symlink the base branch commits
   * (`.claude` pointing elsewhere, say) is never followed or written through,
   * and nothing already there is overwritten.
   */
  private async copyLocalFiles(repoRoot: string, path: string): Promise<void> {
    const patterns = this.deps.settings.get(WORKTREE_COPY_PATTERNS_KEY)
      .split('\n').map((p) => p.trim()).filter((p) => p !== '' && !p.startsWith('#'));
    const matched = await this.cmd.untrackedMatching(repoRoot, patterns);
    const files = new Set([...ALWAYS_COPIED, ...matched.filter((f) => !f.startsWith(`${WORKTREES_DIR}/`))]);
    const root = realpathSync(path);
    for (const file of files) {
      const from = join(repoRoot, file);
      const to = join(path, file);
      if (!isWithin(to, path)) continue;
      try {
        if (!statSync(from, { throwIfNoEntry: false })?.isFile()) continue;
        if (!makeDirsInside(path, relative(path, dirname(to)))) continue;
        const dir = realpathSync(dirname(to));
        if (dir !== root && !isWithin(dir, root)) continue;
        // Exclusive: a file or a symlink there already is left alone.
        if (lstatSync(to, { throwIfNoEntry: false })) continue;
        copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
      } catch {
        // Unreadable, gone between the listing and the copy, or taken meanwhile: skipped, as a missing one is.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Removal

  /** The worktree the session works in now, or null when it does not work in one. */
  linkedTreeOf(row: SessionRow): LinkedWorktree | null {
    if (this.deps.inSetup?.(row.id)) return null;
    return linkedWorktreeOf(this.deps.trees?.workingDir(row) ?? row.cwd);
  }

  async state(row: SessionRow): Promise<WorktreeState | null> {
    const tree = this.linkedTreeOf(row);
    if (!tree) return null;
    const { ctx } = this.deps;
    const path = tree.dirs.root;
    // On its way out: offered again, it would be removed twice.
    if (this.removing.has(path)) return null;
    const [uncommitted, upstream] = await Promise.all([this.cmd.uncommittedFiles(path), this.cmd.upstream(path)]);
    if (uncommitted === null) return null;
    const pushed = upstream !== null || (tree.branch !== null && (await this.cmd.branchExists(path, tree.branch, 'origin')));
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

  /**
   * Removes the session's worktree, never its branch. What the user
   * confirmed is checked against the state now — the path, and whether the
   * session ends with it — and a refusal ends nothing, unless the caller is
   * End (`endSession: 'always'`), which ends the session whatever becomes of
   * the worktree. The session is ended and stopped before git removes the
   * directory under it. A removal git refuses is recorded. With
   * `stoppedLater`, the answer comes once the session has ended and git
   * goes on alone.
   */
  async remove(row: SessionRow, opts: RemoveOptions): Promise<RemoveResult> {
    const always = opts.endSession === 'always';
    const endAnyway = async (): Promise<boolean> => {
      if (!always) return false;
      await opts.end(row.id);
      return true;
    };
    const state = await this.state(row);
    if (!state) return { ok: false, error: 'not_worktree', ended: await endAnyway() };
    const refusal = (opts.path !== undefined && opts.path !== state.path)
      || (!always && opts.endSession !== state.endsSession)
      ? 'worktree_state_changed'
      : this.refusalOf(state, opts.force);
    if (refusal) return { ok: false, error: refusal, ended: false };
    // Another End got here first (the Mac and a phone at once, say): its removal stands.
    if (this.removing.has(state.path)) return { ok: false, error: 'not_worktree', ended: await endAnyway() };
    const ended = always || state.endsSession;
    if (opts.stoppedLater) {
      // Claimed before anything is awaited, so a second End sees it.
      const ending = ended ? opts.end(row.id) : Promise.resolve();
      this.removeLater(state.path, opts.force, row.id, ending, opts.stoppedLater);
      await ending;
      return { ok: true, ended };
    }
    if (ended) await opts.end(row.id);
    const removed = await this.removePath(state.path, opts.force, row.id);
    return { ...removed, ended };
  }

  /** Waits for the removals End left running, before the server closes. */
  async settled(): Promise<void> {
    await Promise.all(this.removing.values());
  }

  private removeLater(
    path: string, force: boolean, sessionId: string,
    ending: Promise<void>, stopped: (id: string) => Promise<void>,
  ): void {
    const run = (async () => {
      try {
        await ending;
      } catch {
        // End's own failure: its caller reports it, and nothing is removed.
        return;
      }
      try {
        await stopped(sessionId);
        // The dialog closed before git ran: the session continued from
        // history, or a new one started in the folder, is not cut off.
        if (this.occupantsOf(path).length > 0) {
          this.record(`The worktree ${path} was not removed: a session works in it again.`, null, { path, force }, sessionId);
          return;
        }
        await this.removePath(path, force, sessionId);
      } catch (err) {
        this.record(`The worktree ${path} could not be removed.`, err instanceof Error ? err.message : String(err), { path, force }, sessionId);
      }
    })().finally(() => {
      if (this.removing.get(path) === run) this.removing.delete(path);
    });
    this.removing.set(path, run);
  }

  /** Why removing would be refused, or null when it may go ahead. */
  private refusalOf(state: WorktreeState, force: boolean): WorktreeRemoveRefusal | null {
    if (state.variant === 'c3') return 'worktree_shared';
    if (!state.removable) return 'worktree_live_terminal';
    if (state.uncommittedFiles > 0 && !force) return 'worktree_dirty';
    return null;
  }

  /** `git worktree remove [--force]`, run from the main checkout; a refusal is recorded. */
  private async removePath(
    path: string, force: boolean, sessionId: string,
  ): Promise<{ ok: true } | { ok: false; error: 'worktree_failed'; message: string }> {
    const dirs = resolveGitDirs(path);
    const repoRoot = dirs ? await this.cmd.mainCheckoutOf(dirs.root, dirs.commonDir) : dirname(path);
    const res = await this.cmd.removeWorktree(repoRoot, path, force);
    if (res.code !== 0) {
      const message = res.stderr.trim() || 'git worktree remove failed.';
      this.record(`The worktree ${path} could not be removed.`, message, { path, force }, sessionId);
      return { ok: false, error: 'worktree_failed', message };
    }
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
