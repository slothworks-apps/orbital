import { EventEmitter } from 'node:events';
import {
  ghAvailability as realGhAvailability,
  lookupPr as realLookupPr,
  readLines as realReadLines,
  type BranchLines,
  type BranchPr,
  type BranchStatus,
  type GhAvailability,
  type PrLookup,
} from './branchStatus.js';
import { defaultBranchOf } from './gitState.js';
import type { GitStore } from './store.js';

/** Settings → Appearance → PR switch; read as `=== 'true'`. */
export const PR_SETTING = 'header_pull_request';
/** Settings → Appearance → line changes; `branch` and `split` turn it on. */
export const LINES_SETTING = 'header_line_changes';

/**
 * Quiet time after the last lines trigger before the recount runs. Edits come
 * in bursts; one recount per burst is the point.
 */
export const LINES_QUIET_MS = 1500;
/**
 * The longest a lines trigger waits, however steadily triggers keep coming —
 * a long run of edits still updates as it goes (spec § When it refreshes).
 */
export const LINES_MAX_WAIT_MS = 8000;
/** How often a watched working tree's PR is looked up again. */
export const PR_INTERVAL_MS = 60_000;

/** One working tree's cached reading and the timers that keep it fresh. */
interface Root {
  /** The watched sessions in it: `session:<id>` has a subscriber. */
  sessions: Set<string>;
  lines?: BranchLines;
  pr?: BranchPr;
  /** The branch last seen, so a `HEAD` event can tell a switch from a commit. */
  ref?: string;
  quietTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  prTimer: ReturnType<typeof setInterval> | null;
  linesInFlight: boolean;
  linesAgain: boolean;
  prInFlight: boolean;
  prAgain: boolean;
}

export interface BranchStatusStoreOptions {
  git: GitStore;
  settings: { get(key: string): string };
  /** Injected so no test spawns `git` or `gh`. */
  readLines?: (root: string, parent: string | null) => Promise<BranchLines | null>;
  lookupPr?: (root: string, branch: string) => Promise<PrLookup>;
  ghAvailability?: () => Promise<GhAvailability>;
  defaultBranch?: (commonDir: string) => string | null;
}

/**
 * Line changes and the pull request per working tree root, read only for
 * trees a window is looking at (spec 2026-09-30-branch-pr-and-line-changes-design
 * § When it refreshes; adr ambient-changes-republish-only-watched-sessions).
 * The value belongs to the directory, like `GitLocation` (adr
 * git-location-is-ambient-not-recorded).
 *
 * Emits `change` (root, cwds) only when a cached value actually changed —
 * and for every cached root when a setting changes, since what `get` returns
 * does. `index.ts` turns it into `republishCwds`.
 *
 * With both settings off it spawns nothing: no timers, no reads. It still
 * records which sessions are watched, so turning a setting on can start.
 */
export class BranchStatusStore extends EventEmitter {
  private roots = new Map<string, Root>();
  private rootBySession = new Map<string, string>();
  private git: GitStore;
  private settings: { get(key: string): string };
  private readLines: NonNullable<BranchStatusStoreOptions['readLines']>;
  private lookupPr: NonNullable<BranchStatusStoreOptions['lookupPr']>;
  private ghAvailability: NonNullable<BranchStatusStoreOptions['ghAvailability']>;
  private defaultBranch: NonNullable<BranchStatusStoreOptions['defaultBranch']>;
  private closed = false;
  private onHead = (root: string) => this.headMoved(root);
  private onIndex = (root: string) => this.triggerLines(root);

  constructor(opts: BranchStatusStoreOptions) {
    super();
    this.git = opts.git;
    this.settings = opts.settings;
    this.readLines = opts.readLines ?? ((root, parent) => realReadLines(root, parent));
    this.lookupPr = opts.lookupPr ?? ((root, branch) => realLookupPr(root, branch));
    this.ghAvailability = opts.ghAvailability ?? (() => realGhAvailability());
    this.defaultBranch = opts.defaultBranch ?? defaultBranchOf;
    this.git.on('change', this.onHead);
    this.git.on('index', this.onIndex);
  }

  private prOn(): boolean {
    return this.settings.get(PR_SETTING) === 'true';
  }

  private linesOn(): boolean {
    const value = this.settings.get(LINES_SETTING);
    // `split` only draws the same numbers differently (spec § Settings).
    return value === 'branch' || value === 'split';
  }

  /**
   * What the session payload carries for this directory: the cached value,
   * filtered by the settings. Undefined when both are off or nothing is known.
   */
  get(cwd: string): BranchStatus | undefined {
    const pr = this.prOn();
    const lines = this.linesOn();
    if (!pr && !lines) return undefined;
    const root = this.git.rootOf(cwd);
    const entry = root === null ? undefined : this.roots.get(root);
    if (!entry) return undefined;
    const status: BranchStatus = {};
    if (lines && entry.lines) status.lines = entry.lines;
    if (pr && entry.pr) status.pr = entry.pr;
    return status.lines || status.pr ? status : undefined;
  }

  /** A window opened this session: its working tree is read and kept fresh. */
  watchSession(sessionId: string, cwd: string): void {
    if (this.rootBySession.has(sessionId)) return;
    const root = this.git.rootOf(cwd);
    if (root === null) return;
    this.rootBySession.set(sessionId, root);
    const entry = this.entry(root);
    entry.sessions.add(sessionId);
    if (entry.sessions.size === 1) this.startWatching(root, entry);
  }

  /** The last window on this session closed. The cache stays; the timers stop. */
  unwatchSession(sessionId: string): void {
    const root = this.rootBySession.get(sessionId);
    if (root === undefined) return;
    this.rootBySession.delete(sessionId);
    const entry = this.roots.get(root);
    if (!entry) return;
    entry.sessions.delete(sessionId);
    if (entry.sessions.size === 0) this.stopTimers(entry);
  }

  /**
   * A transcript in these directories was written to — a tool ran, a turn
   * ended. Recounts lines, never looks up the PR (spec § When it refreshes).
   */
  transcriptActivity(cwds: Iterable<string>): void {
    const roots = new Set<string>();
    for (const cwd of cwds) {
      const root = this.git.rootOf(cwd);
      if (root !== null) roots.add(root);
    }
    for (const root of roots) this.triggerLines(root);
  }

  /** Transcript activity that named no directory: every watched tree counts. */
  transcriptActivityAnywhere(): void {
    for (const root of this.watchedRoots()) this.triggerLines(root);
  }

  /** The app regained focus: PR and lines for every watched tree, now. */
  refreshAll(): void {
    for (const root of this.watchedRoots()) {
      const entry = this.roots.get(root)!;
      this.clearDebounce(entry);
      void this.recountLines(root);
      void this.refreshPr(root);
    }
  }

  /**
   * One of the two settings changed: restart every watched tree under the new
   * settings, and tell every cached root, since what `get` returns changed.
   */
  settingsChanged(): void {
    for (const [root, entry] of this.roots) {
      this.stopTimers(entry);
      if (entry.sessions.size > 0) this.startWatching(root, entry);
      this.emit('change', root, this.git.cwdsFor(root));
    }
  }

  /** Whether the PR switch can be on, and if not, why (spec § Settings). */
  ghStatus(): Promise<GhAvailability> {
    return this.ghAvailability();
  }

  close(): void {
    this.closed = true;
    this.git.off('change', this.onHead);
    this.git.off('index', this.onIndex);
    for (const entry of this.roots.values()) this.stopTimers(entry);
  }

  private entry(root: string): Root {
    let entry = this.roots.get(root);
    if (!entry) {
      entry = {
        sessions: new Set(), quietTimer: null, maxTimer: null, prTimer: null,
        linesInFlight: false, linesAgain: false, prInFlight: false, prAgain: false,
      };
      this.roots.set(root, entry);
    }
    return entry;
  }

  private watchedRoots(): string[] {
    return [...this.roots].filter(([, entry]) => entry.sessions.size > 0).map(([root]) => root);
  }

  private isWatched(root: string): boolean {
    return !this.closed && (this.roots.get(root)?.sessions.size ?? 0) > 0;
  }

  private startWatching(root: string, entry: Root): void {
    entry.ref = this.git.treeOf(root)?.location?.ref;
    if (this.linesOn()) void this.recountLines(root);
    if (this.prOn()) {
      void this.refreshPr(root);
      entry.prTimer = setInterval(() => {
        if (this.isWatched(root)) void this.refreshPr(root);
        else this.stopTimers(entry);
      }, PR_INTERVAL_MS);
    }
  }

  private stopTimers(entry: Root): void {
    this.clearDebounce(entry);
    if (entry.prTimer) clearInterval(entry.prTimer);
    entry.prTimer = null;
  }

  private clearDebounce(entry: Root): void {
    if (entry.quietTimer) clearTimeout(entry.quietTimer);
    if (entry.maxTimer) clearTimeout(entry.maxTimer);
    entry.quietTimer = null;
    entry.maxTimer = null;
  }

  /** `HEAD` moved: always a recount; a PR lookup only when the branch changed. */
  private headMoved(root: string): void {
    if (!this.isWatched(root)) return;
    const entry = this.roots.get(root)!;
    const ref = this.git.treeOf(root)?.location?.ref;
    if (ref !== entry.ref) {
      entry.ref = ref;
      void this.refreshPr(root);
    }
    this.triggerLines(root);
  }

  /**
   * Every lines trigger but a watch start and a focus comes through here: one
   * recount after a quiet interval, and no later than the maximum wait after
   * the first trigger of a burst.
   */
  private triggerLines(root: string): void {
    if (!this.isWatched(root) || !this.linesOn()) return;
    const entry = this.roots.get(root)!;
    const fire = () => {
      this.clearDebounce(entry);
      void this.recountLines(root);
    };
    if (entry.quietTimer) clearTimeout(entry.quietTimer);
    entry.quietTimer = setTimeout(fire, LINES_QUIET_MS);
    entry.maxTimer ??= setTimeout(fire, LINES_MAX_WAIT_MS);
  }

  /**
   * The branch the count is taken against (spec § Lines — the parent): none
   * on a detached HEAD or on the default branch, the PR's base when the PR
   * setting is on and one is known, the default branch otherwise. Undefined:
   * the tree is not readable at all.
   *
   * The default branch is looked up here rather than taken from
   * `GitLocation.defaultBranch`, which is always false for a worktree — and
   * a worktree checked out on the default branch has no parent either.
   */
  private parentOf(root: string): string | null | undefined {
    const trunk = this.trunkOf(root);
    if (trunk === undefined) return undefined;
    if (trunk.onTrunk) return null;
    const pr = this.roots.get(root)?.pr;
    if (this.prOn() && pr) return pr.base;
    return trunk.defaultBranch;
  }

  /**
   * The checked-out branch against the default one. `onTrunk`: a detached
   * HEAD or the default branch itself, where there is no parent and no PR.
   */
  private trunkOf(
    root: string,
  ): { ref: string; defaultBranch: string | null; onTrunk: boolean } | undefined {
    const tree = this.git.treeOf(root);
    const location = tree?.location;
    if (!tree || !location) return undefined;
    const defaultBranch = location.detached ? null : this.defaultBranch(tree.dirs.commonDir);
    const onTrunk = location.detached || (defaultBranch !== null && location.ref === defaultBranch);
    return { ref: location.ref, defaultBranch, onTrunk };
  }

  /** One read in flight per root; a trigger during it runs one more after. */
  private async recountLines(root: string): Promise<void> {
    const entry = this.roots.get(root);
    if (!entry || !this.isWatched(root) || !this.linesOn()) return;
    if (entry.linesInFlight) {
      entry.linesAgain = true;
      return;
    }
    const parent = this.parentOf(root);
    if (parent === undefined) return;
    entry.linesInFlight = true;
    try {
      const lines = await this.readLines(root, parent);
      // Null is no answer (a timeout, a failed spawn): the last good stays.
      if (lines) this.update(root, entry, () => { entry.lines = lines; });
    } finally {
      entry.linesInFlight = false;
      if (entry.linesAgain) {
        entry.linesAgain = false;
        void this.recountLines(root);
      }
    }
  }

  private async refreshPr(root: string): Promise<void> {
    const entry = this.roots.get(root);
    if (!entry || !this.isWatched(root) || !this.prOn()) return;
    if (entry.prInFlight) {
      entry.prAgain = true;
      return;
    }
    const trunk = this.trunkOf(root);
    if (!trunk) return;
    // No PR is looked for on a detached HEAD or the default branch, and one
    // cached from the branch before is dropped.
    if (trunk.onTrunk) {
      this.update(root, entry, () => { entry.pr = undefined; });
      return;
    }
    const parentBefore = this.parentOf(root);
    entry.prInFlight = true;
    try {
      const branch = trunk.ref;
      const result = await this.lookupPr(root, branch);
      // The branch moved while gh was out: the answer is for the old one, and
      // the `HEAD` event already asked again.
      if (this.git.treeOf(root)?.location?.ref !== branch) return;
      this.update(root, entry, () => {
        if (result.kind === 'pr') entry.pr = result.pr;
        else if (result.kind !== 'failed') entry.pr = undefined;
      });
      if (this.parentOf(root) !== parentBefore) void this.recountLines(root);
    } finally {
      entry.prInFlight = false;
      if (entry.prAgain) {
        entry.prAgain = false;
        void this.refreshPr(root);
      }
    }
  }

  /** Applies a change and emits `change` only when the value really moved. */
  private update(root: string, entry: Root, apply: () => void): void {
    const before = JSON.stringify([entry.lines, entry.pr]);
    apply();
    if (JSON.stringify([entry.lines, entry.pr]) === before) return;
    this.emit('change', root, this.git.cwdsFor(root));
  }
}
