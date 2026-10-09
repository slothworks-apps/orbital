/**
 * The app updating itself: whether to look for an update at all, and when a
 * downloaded one may restart the app (spec
 * 2026-10-08-builds-for-testers-design § The desktop app updates itself; ADR
 * the-desktop-app-updates-itself).
 *
 * Nothing here may import electron: `main.ts` feeds in what electron-updater
 * and the sessions feed report, and calls `quitAndInstall` when told to.
 */

/**
 * How often a running app looks for a newer release, after the check at
 * launch. A tester's app is open for days; a few hours keeps it near the
 * newest release without asking GitHub more than it needs to.
 */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * A dev build has no release to compare with, and a build from `dist:local`
 * or `dist:self` carries no `app-update.yml` — it does not know where its
 * releases are, and must not replace itself with a published one.
 */
export function shouldCheckForUpdates(build: { isPackaged: boolean; hasAppUpdateYml: boolean }): boolean {
  return build.isPackaged && build.hasAppUpdateYml;
}

/** What the user can do with a downloaded update, from the prompt. */
export type UpdateAction = 'restart-now' | 'restart-when-idle' | 'cancel-wait' | 'dismiss';

const ACTIONS: readonly UpdateAction[] = ['restart-now', 'restart-when-idle', 'cancel-wait', 'dismiss'];

/** An action off IPC, or null for anything a renderer should not have sent. */
export function parseUpdateAction(raw: unknown): UpdateAction | null {
  return ACTIONS.includes(raw as UpdateAction) ? (raw as UpdateAction) : null;
}

/**
 * What the web app is told, and all it needs to draw the prompt.
 *
 * - `ready` — downloaded, offered: one Restart when nothing is working, else
 *   Restart now and Restart when sessions finish, with `workingCount`.
 * - `waiting` — the user chose to restart once no Orbital session works.
 * - `dismissed` — the prompt was closed; the update installs when Orbital
 *   quits, and this version is not offered again.
 * - `restarting` — `quitAndInstall` has been called.
 */
export type UpdateView =
  | { phase: 'none' }
  | {
      phase: 'ready' | 'waiting' | 'dismissed' | 'restarting';
      version: string;
      /** Orbital sessions mid-turn — what a restart now would interrupt. */
      workingCount: number;
    };

const PHASES = new Set(['ready', 'waiting', 'dismissed', 'restarting']);

/** A view off IPC; anything malformed reads as no update, never as a prompt. */
export function parseUpdateView(raw: unknown): UpdateView {
  if (typeof raw !== 'object' || raw === null) return { phase: 'none' };
  const { phase, version, workingCount } = raw as Record<string, unknown>;
  if (
    typeof phase !== 'string' ||
    !PHASES.has(phase) ||
    typeof version !== 'string' ||
    version === '' ||
    typeof workingCount !== 'number' ||
    !Number.isInteger(workingCount) ||
    workingCount < 0
  ) {
    return { phase: 'none' };
  }
  return { phase: phase as Exclude<UpdateView['phase'], 'none'>, version, workingCount };
}

/**
 * What one input did: whether the view the web app holds is now stale, and
 * whether `main.ts` must call `quitAndInstall` now.
 */
export type UpdateStep = { changed: boolean; restart: boolean };

type Phase = UpdateView['phase'];

/**
 * The restart's state machine. The working count is `WorkingSessions.count`,
 * which already counts only Orbital-run sessions: a terminal session belongs
 * to a CLI in someone's shell, and restarting the app does not touch it.
 */
export class UpdateFlow {
  private phase: Phase = 'none';
  private version = '';
  private workingCount = 0;
  /** The version whose prompt was closed; it is not offered again. */
  private dismissedVersion: string | null = null;

  get view(): UpdateView {
    if (this.phase === 'none') return { phase: 'none' };
    return { phase: this.phase, version: this.version, workingCount: this.workingCount };
  }

  /** electron-updater finished downloading `version`. */
  downloaded(version: string): UpdateStep {
    if (this.phase === 'restarting') return this.step(false);
    const before = this.snapshot();
    this.version = version;
    if (version === this.dismissedVersion) this.phase = 'dismissed';
    // A newer version arriving during a wait keeps the wait: the user asked
    // to restart once the sessions finish, and that restart installs it.
    else if (this.phase !== 'waiting') this.phase = 'ready';
    return this.step(before !== this.snapshot());
  }

  /** The number of Orbital sessions mid-turn changed (or was re-read). */
  setWorkingCount(count: number): UpdateStep {
    const before = this.snapshot();
    this.workingCount = count;
    const changed = this.phase !== 'none' && before !== this.snapshot();
    if (this.phase === 'waiting' && count === 0) return this.restart();
    return this.step(changed);
  }

  /** A button in the prompt. */
  act(action: UpdateAction): UpdateStep {
    if (this.phase === 'none' || this.phase === 'restarting') return this.step(false);
    const before = this.snapshot();
    switch (action) {
      case 'restart-now':
        return this.restart();
      case 'restart-when-idle':
        if (this.workingCount === 0) return this.restart();
        this.phase = 'waiting';
        break;
      case 'cancel-wait':
        if (this.phase === 'waiting') this.phase = 'ready';
        break;
      case 'dismiss':
        // Closing the prompt abandons a wait too: what is left is the install
        // on quit, which needs nothing from us.
        this.dismissedVersion = this.version;
        this.phase = 'dismissed';
        break;
    }
    return this.step(before !== this.snapshot());
  }

  private restart(): UpdateStep {
    this.phase = 'restarting';
    return { changed: true, restart: true };
  }

  private step(changed: boolean): UpdateStep {
    return { changed, restart: false };
  }

  private snapshot(): string {
    return JSON.stringify(this.view);
  }
}
