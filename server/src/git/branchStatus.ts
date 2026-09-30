import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/**
 * How far a working tree's branch has got: its line changes against a parent
 * and its pull request (spec 2026-09-30-branch-pr-and-line-changes-design).
 * Both come from spawned `git` and `gh` processes — the first place the
 * server spawns either (adr branch-status-comes-from-git-and-gh-processes).
 *
 * This module only computes a reading for one working tree root. When to take
 * one, and for whom, is decided by the caller.
 */

export interface LineCounts {
  added: number;
  removed: number;
}

export interface BranchLines {
  /** The branch the count is taken against; null: no parent, uncommitted only. */
  parent: string | null;
  committed: LineCounts;
  uncommitted: LineCounts;
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type PrReview = 'approved' | 'changes_requested' | 'review_required' | null;
export interface PrChecks {
  passed: number;
  failed: number;
  pending: number;
}

export interface BranchPr {
  number: number;
  url: string;
  state: PrState;
  review: PrReview;
  /** Null: the PR has no checks at all. */
  checks: PrChecks | null;
  /** `baseRefName` — the parent the line count is taken against. */
  base: string;
}

export interface BranchStatus {
  lines?: BranchLines;
  pr?: BranchPr;
}

export type GhAvailability = 'ready' | 'missing' | 'logged_out';

export type PrLookup =
  | { kind: 'pr'; pr: BranchPr }
  /** No PR for this branch — also what a repository without a GitHub remote gets. */
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: 'missing' | 'logged_out' }
  /** Timeout or anything unrecognised: the caller keeps its last good value. */
  | { kind: 'failed' };

/** How long one `git` read may take before the reading is given up. */
const GIT_TIMEOUT_MS = 10_000;

/** How long `gh pr view` may take; it goes to the network. */
const GH_TIMEOUT_MS = 15_000;

/** How long `gh auth status` may take before gh counts as logged out. */
const GH_AUTH_TIMEOUT_MS = 10_000;

/** Output ceiling per spawn; a numstat over a large tree or a long check rollup fits. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Untracked files bigger than this are left out of the count (canvas note). */
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;

/**
 * Untracked files counted before the count stops. A tree with a forgotten
 * build directory outside `.gitignore` would otherwise be read in full on
 * every recount.
 */
const MAX_UNTRACKED_FILES = 2000;

/** How much of a file is searched for a NUL byte — the same sniff git makes. */
const BINARY_SNIFF_BYTES = 8000;

/** Where Homebrew puts `gh`; the packaged app's `PATH` may not include them. */
const GH_FALLBACK_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'];

// ---------------------------------------------------------------------------
// Spawning

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when the process never ran or was killed. */
  code: number | null;
  /** The process did not finish within its timeout. */
  timedOut: boolean;
}

/** Runs a binary without a shell. Injectable so tests need no `gh` and no network. */
export type Runner = (
  file: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number },
) => Promise<RunResult>;

const execRunner: Runner = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { ...opts, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0, timedOut: false });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: typeof e.code === 'number' ? e.code : null,
          timedOut: e.killed === true,
        });
      },
    );
  });

// ---------------------------------------------------------------------------
// Lines

/**
 * Sums `git diff --numstat` output. Takes the `-z` form, where a path is never
 * quoted and a rename is a record with an empty path followed by the two
 * paths as records of their own; the plain newline form is accepted too.
 * Binary files (`-\t-`) count zero, as the spec asks.
 */
export function parseNumstat(out: string): LineCounts {
  const counts: LineCounts = { added: 0, removed: 0 };
  const z = out.includes('\0');
  const records = out.split(z ? '\0' : '\n');
  for (let i = 0; i < records.length; i++) {
    const match = records[i].match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!match) continue;
    if (match[1] !== '-') counts.added += Number(match[1]);
    if (match[2] !== '-') counts.removed += Number(match[2]);
    // A `-z` rename: the old and new path follow as two records, and either
    // could itself look like a numstat line.
    if (z && match[3] === '') i += 2;
  }
  return counts;
}

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  // The reads run beside an agent that may be committing; they must never
  // take the index lock from under it.
  GIT_OPTIONAL_LOCKS: '0',
});

interface LinesOpts {
  run?: Runner;
  timeoutMs?: number;
}

/**
 * Line changes of the working tree at `root` against `parent`, the uncommitted
 * work included (spec § Line changes).
 *
 * The count is taken from the merge base, so commits that reached the parent
 * after the branch forked do not count. The parent is tried as
 * `origin/<parent>` first, then as given; one that resolves as neither is
 * treated like none: the uncommitted work
 * alone. Null for anything else going wrong — not a repository, no `git`, a
 * timeout.
 */
export async function readLines(
  root: string,
  parent: string | null,
  opts: LinesOpts = {},
): Promise<BranchLines | null> {
  const run = opts.run ?? execRunner;
  const timeout = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const git = (args: string[]) => run('git', args, { cwd: root, env: gitEnv(), timeout });

  let base: string | null = null;
  if (parent !== null) {
    // The remote first: GitHub compares a PR against it, and a local copy
    // that has fallen behind would count the parent's newer commits as the
    // branch's own.
    for (const candidate of [`origin/${parent}`, parent]) {
      // A branch name may start with `-`; it must not read as an option.
      const res = await git(['merge-base', '--end-of-options', 'HEAD', candidate]);
      // A slow repository is no answer, not a missing parent: the uncommitted
      // count alone would be passed off as the whole change.
      if (res.timedOut) return null;
      if (res.code === 0 && res.stdout.trim()) {
        base = res.stdout.trim();
        break;
      }
    }
  }

  const uncommittedRes = await git(['diff', '--numstat', '-z', 'HEAD']);
  if (uncommittedRes.code !== 0) return null;
  const uncommitted = parseNumstat(uncommittedRes.stdout);

  let committed: LineCounts = { added: 0, removed: 0 };
  if (base !== null) {
    const committedRes = await git(['diff', '--numstat', '-z', base, 'HEAD']);
    if (committedRes.code !== 0) return null;
    committed = parseNumstat(committedRes.stdout);
  }

  const untrackedRes = await git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (untrackedRes.code !== 0) return null;
  const untracked = untrackedRes.stdout.split('\0').filter(Boolean);
  uncommitted.added += await countUntrackedLines(root, untracked);

  return { parent: base === null ? null : parent, committed, uncommitted };
}

/**
 * Lines in files nobody has `git add`-ed yet, which the spec counts as added.
 * Files over `MAX_UNTRACKED_FILE_BYTES` are skipped, the walk stops after
 * `MAX_UNTRACKED_FILES`, and a binary file counts zero.
 */
async function countUntrackedLines(root: string, paths: string[]): Promise<number> {
  let total = 0;
  for (const path of paths.slice(0, MAX_UNTRACKED_FILES)) {
    try {
      const full = join(root, path);
      const info = await stat(full);
      if (!info.isFile() || info.size > MAX_UNTRACKED_FILE_BYTES) continue;
      const buf = await readFile(full);
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
      total += countLines(buf);
    } catch {
      // Deleted or unreadable between the listing and the read: not counted.
    }
  }
  return total;
}

/** Lines as git counts them: a last line without a newline still counts. */
function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let lines = 0;
  for (const byte of buf) if (byte === 0x0a) lines++;
  return buf[buf.length - 1] === 0x0a ? lines : lines + 1;
}

// ---------------------------------------------------------------------------
// Pull request

const PR_FIELDS = 'number,url,state,isDraft,baseRefName,reviewDecision,statusCheckRollup';

const REVIEWS: Record<string, PrReview> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
};

const CHECK_PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS']);
const CHECK_PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CHECK_FAILED = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

/**
 * `statusCheckRollup` mixes check runs (`status` + `conclusion`) and commit
 * status contexts (`state`). A check run that has not completed is pending
 * whatever its conclusion says; otherwise both reduce to one word.
 * Null for an empty rollup: the PR has no checks at all.
 */
function tallyChecks(rollup: unknown): PrChecks | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  const checks: PrChecks = { passed: 0, failed: 0, pending: 0 };
  for (const entry of rollup) {
    if (!entry || typeof entry !== 'object') continue;
    const { status, conclusion, state } = entry as Record<string, unknown>;
    if (typeof status === 'string' && status !== 'COMPLETED') {
      checks.pending++;
      continue;
    }
    const word = typeof conclusion === 'string' && conclusion ? conclusion : state;
    if (typeof word !== 'string') continue;
    if (CHECK_PENDING.has(word)) checks.pending++;
    else if (CHECK_PASSED.has(word)) checks.passed++;
    else if (CHECK_FAILED.has(word)) checks.failed++;
  }
  return checks;
}

function prState(state: unknown, isDraft: unknown): PrState | null {
  switch (state) {
    case 'OPEN':
      return isDraft === true ? 'draft' : 'open';
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'closed';
    default:
      return null;
  }
}

/** `gh pr view --json` output → the PR, or null when it lacks what the header needs. */
export function parsePrView(json: unknown): BranchPr | null {
  if (!json || typeof json !== 'object') return null;
  const view = json as Record<string, unknown>;
  const state = prState(view.state, view.isDraft);
  if (
    !Number.isInteger(view.number) ||
    typeof view.url !== 'string' ||
    typeof view.baseRefName !== 'string' ||
    state === null
  ) {
    return null;
  }
  return {
    number: view.number as number,
    url: view.url,
    state,
    review: typeof view.reviewDecision === 'string' ? (REVIEWS[view.reviewDecision] ?? null) : null,
    checks: tallyChecks(view.statusCheckRollup),
    base: view.baseRefName,
  };
}

const ghEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  NO_COLOR: '1',
  // gh otherwise checks for its own new release over the network on a run.
  GH_NO_UPDATE_NOTIFIER: '1',
});

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `gh` binary: `PATH` first, then the Homebrew locations. The packaged app
 * swaps in the login shell's `PATH` at startup (`applyLoginShellPath`); the
 * fallback covers a shell that could not be asked.
 */
export function resolveGh(
  opts: { pathVar?: string; exists?: (path: string) => boolean } = {},
): string | null {
  const exists = opts.exists ?? isExecutable;
  const pathVar = 'pathVar' in opts ? opts.pathVar : process.env.PATH;
  const pathDirs = (pathVar ?? '').split(delimiter).filter(Boolean);
  for (const candidate of [...pathDirs.map((dir) => join(dir, 'gh')), ...GH_FALLBACK_PATHS]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

interface GhOpts {
  run?: Runner;
  /** The resolved binary; `resolveGh()` when absent. */
  resolve?: () => string | null;
  timeoutMs?: number;
}

/** gh's own words for "no login", from `gh auth` and from any command it refuses. */
const LOGGED_OUT = /gh auth login|not logged in/i;

/** gh's own words for "there is no PR to show" — including no GitHub remote at all. */
const NO_PR = /no pull requests found|could not find|none of the git remotes/i;

/**
 * The PR for `branch`, looked up with the user's own `gh` login from the
 * working tree root, so `gh` resolves the repository from its remotes.
 */
export async function lookupPr(root: string, branch: string, opts: GhOpts = {}): Promise<PrLookup> {
  const gh = (opts.resolve ?? resolveGh)();
  if (!gh) return { kind: 'unavailable', reason: 'missing' };
  const run = opts.run ?? execRunner;
  // `--` so a branch name starting with `-` is not read as a flag.
  const res = await run(gh, ['pr', 'view', '--json', PR_FIELDS, '--', branch], {
    cwd: root,
    env: ghEnv(),
    timeout: opts.timeoutMs ?? GH_TIMEOUT_MS,
  });
  if (res.timedOut) return { kind: 'failed' };
  if (res.code === 0) {
    let json: unknown;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      return { kind: 'failed' };
    }
    const pr = parsePrView(json);
    return pr ? { kind: 'pr', pr } : { kind: 'failed' };
  }
  if (LOGGED_OUT.test(res.stderr)) return { kind: 'unavailable', reason: 'logged_out' };
  if (NO_PR.test(res.stderr)) return { kind: 'none' };
  return { kind: 'failed' };
}

/** Whether the PR switch in Settings can be on, and if not, why (spec § Settings). */
export async function ghAvailability(opts: GhOpts = {}): Promise<GhAvailability> {
  const gh = (opts.resolve ?? resolveGh)();
  if (!gh) return 'missing';
  const run = opts.run ?? execRunner;
  const res = await run(gh, ['auth', 'status'], {
    env: ghEnv(),
    timeout: opts.timeoutMs ?? GH_AUTH_TIMEOUT_MS,
  });
  return res.code === 0 ? 'ready' : 'logged_out';
}
