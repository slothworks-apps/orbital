/**
 * Work in a worktree (spec 2026-11-02-work-in-a-worktree-design): what the
 * Mac, the desktop web and the phone agree on — the wire shapes of its
 * routes, their error codes, where Orbital puts the worktrees it makes, and
 * the pure rule that picks the removal a worktree is offered.
 *
 * No Node imports: the phone and the desktop web import this too.
 */

/** Where Orbital puts the worktrees it makes, relative to the main checkout. */
export const WORKTREES_DIR = '.claude/worktrees';

// ---------------------------------------------------------------------------
// How long the slow routes may take

/** How long `git fetch origin` may take on the Mac; it goes to the network. */
export const FETCH_TIMEOUT_MS = 60_000;

/** How long `git worktree add` may take on the Mac: it checks out a whole tree. */
export const WORKTREE_ADD_TIMEOUT_MS = 120_000;

/**
 * How long a tunnel waits for `POST /api/worktree/fetch`: the fetch, plus
 * the local reads around it.
 */
export const WORKTREE_FETCH_REQUEST_TIMEOUT_MS = FETCH_TIMEOUT_MS + 30_000;

/**
 * How long a tunnel waits for a `POST /api/sessions` that makes a worktree:
 * the checkout, plus the naming call and the git reads before and after it.
 */
export const WORKTREE_LAUNCH_REQUEST_TIMEOUT_MS = WORKTREE_ADD_TIMEOUT_MS + 60_000;

/**
 * The longer answer timeout a request to one of the worktree's slow routes
 * gets on a tunnel, or null for any other request, which keeps the
 * channel's own. A launch is slow only when its body asks for a worktree.
 */
export function slowRequestTimeoutMs(method: string, path: string, body?: unknown): number | null {
  if (method !== 'POST') return null;
  const q = path.indexOf('?');
  const pathname = q < 0 ? path : path.slice(0, q);
  if (pathname === '/api/worktree/fetch') return WORKTREE_FETCH_REQUEST_TIMEOUT_MS;
  if (pathname === '/api/sessions' && body !== null && typeof body === 'object'
    && (body as { worktree?: unknown }).worktree != null) {
    return WORKTREE_LAUNCH_REQUEST_TIMEOUT_MS;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wire shapes

/** One live Orbital session in the checkout the dialog's directory resolves to. */
export interface WorktreeOccupant {
  sessionId: string;
  title: string;
  tagId: string | null;
  branch: string | null;
}

/** `GET /api/worktree/options?cwd=&machine=`. */
export type WorktreeOptions =
  | { git: false }
  | {
      git: true;
      repoRoot: string;
      treeRoot: string;
      defaultBranch: string;
      currentBranch: string | null;
      occupants: WorktreeOccupant[];
      /** The form the repository's branch names take, `feat/` say: the BRANCH placeholder. */
      branchForm: string;
      /** Remote ones as `origin/x`. */
      branches: { local: string[]; remote: string[] };
      /** When `origin` was last fetched, or null when never. */
      fetchedAt: number | null;
      /** The switch starts on: the checkout is occupied and the setting allows it. */
      autoOn: boolean;
    };

export type WorktreeFetchError = 'offline' | 'auth' | 'other';

/** `POST /api/worktree/fetch`. */
export type WorktreeFetchResult =
  | { ok: true; fetchedAt: number }
  | { ok: false; error: WorktreeFetchError; message: string };

/**
 * The four removal variants (canvas 63f): `c1` nothing local would be lost;
 * `c2a` uncommitted files; `c2b` unpushed commits on a clean tree; `c3`
 * another live Orbital session works in the tree.
 */
export type WorktreeVariant = 'c1' | 'c2a' | 'c2b' | 'c3';

/** `GET /api/sessions/:id/worktree`, or `null` outside a linked worktree. */
export interface WorktreeState {
  path: string;
  /** The worktree directory's name. */
  leaf: string;
  branch: string | null;
  pr: { number: number; state: 'open' | 'draft' | 'merged' | 'closed' } | null;
  pushed: boolean;
  uncommittedFiles: number;
  unpushedCommits: number;
  /** Other live Orbital sessions in the tree. */
  sharedWith: string[];
  variant: WorktreeVariant;
  removable: boolean;
  /** Removing it ends the session first (an Orbital session that has not ended): "End and remove". */
  endsSession: boolean;
  /** Keep was pressed for this worktree: the panel strip stays away. */
  dismissed: boolean;
}

/** The worktree part of a launch: `POST /api/sessions`'s `worktree`. */
export interface WorktreeLaunch {
  base: string;
  /** Absent or empty: Orbital names the branch. */
  branch?: string;
}

/** What `POST /api/sessions` refuses a worktree launch with: 400, 409 and 500 in that order. */
export type WorktreeLaunchError = 'worktree_invalid_branch' | 'worktree_branch_exists' | 'worktree_failed';

/**
 * Why a removal was refused, before anything ended or was removed.
 * `worktree_state_changed`: the request's `endSession` or `path` no longer
 * matches the session's worktree — the user confirmed something else.
 */
export type WorktreeRemoveRefusal =
  | 'not_worktree'
  | 'worktree_shared'
  | 'worktree_live_terminal'
  | 'worktree_dirty'
  | 'worktree_state_changed';

/**
 * `POST /api/sessions/:id/worktree/remove`'s body: what the user saw and
 * confirmed. `endSession` must be true exactly when the state said
 * `endsSession`; `path`, when sent, must be the state's `path`.
 */
export interface WorktreeRemoveRequest {
  force?: boolean;
  endSession?: boolean;
  path?: string;
}

/** `POST /api/sessions/:id/end`'s `removeWorktree`. */
export type RemoveWorktreeMode = 'clean' | 'force';

/**
 * The worktree part of `POST /api/sessions/:id/end`'s body. `worktreePath`,
 * when sent with `removeWorktree`, is the path the user confirmed; another
 * path now is refused with 409 `worktree_state_changed` before anything ends.
 */
export interface EndWithWorktreeRequest {
  removeWorktree?: RemoveWorktreeMode;
  worktreePath?: string;
}

/**
 * `POST /api/sessions/:id/end`'s answer. The session has ended whenever the
 * answer is 200. A removal that may go ahead is answered `{ ok: true }`
 * before git runs: it goes on after the answer, and one git refuses reaches
 * the error log. `not_worktree` is a session that no longer works in a
 * worktree. `worktreeRemoved: true` and `worktree_failed` are an older Mac's,
 * which answered after git.
 */
export type EndSessionResult =
  | { ok: true; worktreeRemoved?: true }
  | { ok: true; worktreeRemoved: false; error: 'worktree_failed' | 'not_worktree'; message: string };

// ---------------------------------------------------------------------------
// Setup in the background (spec 2026-11-09-worktree-setup-in-background-design)

/**
 * Where a worktree launch's setup stands. `naming`, `checkout` and `copy`
 * are SETTING UP (steps 1, 2 and 3); `failed` is NOT STARTED; `ready` is a
 * session that has started, kept so the setup block can still say how long
 * it took.
 */
export type SetupPhase = 'naming' | 'checkout' | 'copy' | 'failed' | 'ready';

/** A message sent to a session before it started: queued, sent in order after the first prompt. */
export interface SetupQueuedMessage {
  text: string;
  attachments?: string[];
}

/** The settings a not-started session would launch with, for Try again and Without a worktree. */
export interface SetupLaunchSettings {
  /** The directory New Session was given, not the worktree. */
  cwd: string;
  base: string;
  /** The branch the user typed, when they did. */
  branch?: string;
  permissionMode: string;
  model?: string;
  tagId?: number;
  claudeDirId?: number;
}

/**
 * The session's `setup` on the wire: present only for a session launched
 * into a worktree by a Mac that sets up in the background. While it is
 * present and not `ready`, the session has no process: `status` reads
 * `idle` for clients that do not know `setup`.
 */
export interface SessionSetup {
  phase: SetupPhase;
  /** 1, 2 or 3: the step running, or for `failed` the one that failed; 3 once `ready`. */
  step: 1 | 2 | 3;
  /** Null until the branch is named (step 1). */
  branch: string | null;
  /** The worktree's path, null until its directory is reserved. */
  path: string | null;
  /** How long setup took, once `ready`. */
  readyInMs: number | null;
  /** For `failed`: the one plain sentence saying why. */
  message: string | null;
  /** For `failed`: the error log entry with the full output, when one was recorded. */
  errorId: number | null;
  /** The first prompt and its attachments; empty once `ready`. */
  prompt: string;
  attachments: string[];
  /** Messages sent meanwhile, oldest first; empty once `ready`. */
  queued: SetupQueuedMessage[];
  launch: SetupLaunchSettings;
}

/** `POST /api/sessions/:id/setup/retry` and `POST /api/sessions/:id/discard` refusals. */
export type SetupActionRefusal = 'not_found' | 'not_failed' | 'not_in_setup';

// ---------------------------------------------------------------------------
// Names and paths

/** The worktree's directory name for a branch: its last segment. */
export function leafOf(branch: string): string {
  const parts = branch.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? branch;
}

/** A base without its remote: what `gh-merge-base` and the PR name. */
export function stripOrigin(ref: string): string {
  return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
}

const WORKTREES_SEGMENT = `/${WORKTREES_DIR}/`;

/**
 * The repository a directory under `<repo>/.claude/worktrees/<x>` belongs
 * to, or the directory itself. A subdirectory inside the worktree maps to
 * the repository too: RECENT is about where to start, not about the tree.
 */
export function repoOfWorktreeDir(dir: string): string {
  const at = dir.indexOf(WORKTREES_SEGMENT);
  if (at <= 0) return dir;
  const leaf = dir.slice(at + WORKTREES_SEGMENT.length).split('/')[0];
  return leaf ? dir.slice(0, at) : dir;
}

// ---------------------------------------------------------------------------
// The removal a worktree is offered

export interface WorktreeChoiceInput {
  uncommittedFiles: number;
  unpushedCommits: number;
  /** Other live Orbital sessions in the tree. */
  sharedWith: readonly string[];
  /** The session's status is `ended`. */
  ended: boolean;
  /** Orbital holds the session (not a terminal CLI), so Orbital can end it. */
  orbital: boolean;
}

export interface WorktreeChoice {
  variant: WorktreeVariant;
  /** Whether removal can be offered at all. */
  removable: boolean;
  /** Removing has to end the session first: the UI says "End and remove". */
  endsSession: boolean;
}

/** Which removal a worktree is offered, from its state (spec § Removing the worktree). */
export function worktreeChoice(input: WorktreeChoiceInput): WorktreeChoice {
  const variant: WorktreeVariant = input.sharedWith.length > 0
    ? 'c3'
    : input.uncommittedFiles > 0
      ? 'c2a'
      : input.unpushedCommits > 0
        ? 'c2b'
        : 'c1';
  // A terminal session still running cannot be stopped from here, and its
  // next turn would land in a deleted directory.
  const removable = variant !== 'c3' && (input.ended || input.orbital);
  return { variant, removable, endsSession: removable && !input.ended };
}
