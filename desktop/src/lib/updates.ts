/**
 * The app updating itself: whether to look for an update at all, whether to
 * download one, and when a downloaded one may restart the app (spec
 * 2026-10-08-builds-for-testers-design § The desktop app updates itself; ADR
 * the-desktop-app-updates-itself; canvas `Feature - App update`).
 *
 * Nothing here may import electron: `main.ts` feeds in what electron-updater
 * and the sessions feed report, and does what each step says — download,
 * remember the skipped version, restart.
 */

/**
 * How often a running app looks for a newer release, after the check at
 * launch. A tester's app is open for days; a few hours keeps it near the
 * newest release without asking GitHub more than it needs to.
 */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Settings › Updates › "Download updates automatically", in the server's
 * settings table (`/api/settings`). On only for the literal 'true': off is
 * the default, and anything else reads as it. The server seeds the same key
 * (`server/src/db/database.ts`) and the web app writes it
 * (`web/src/lib/appUpdate.ts`); the workspaces do not import each other.
 */
export const AUTO_DOWNLOAD_KEY = 'update_auto_download';

/** The setting off a `GET /api/settings` body. */
export function parseAutoDownload(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  return (settings as Record<string, unknown>)[AUTO_DOWNLOAD_KEY] === 'true';
}

/**
 * The file in `userData` that remembers a version skipped with × on
 * Available, so it is not offered again after a restart. Main is its only
 * reader and writer.
 */
export const SKIPPED_VERSION_FILE = 'update-skip.json';

export function parseSkippedVersion(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { skippedVersion } = parsed as Record<string, unknown>;
    return typeof skippedVersion === 'string' && skippedVersion !== '' ? skippedVersion : null;
  } catch {
    return null;
  }
}

export function serializeSkippedVersion(version: string | null): string {
  return `${JSON.stringify({ skippedVersion: version })}\n`;
}

/**
 * A dev build has no release to compare with, and a build from `dist:local`
 * or `dist:self` carries no `app-update.yml` — it does not know where its
 * releases are, and must not replace itself with a published one.
 */
export function shouldCheckForUpdates(build: { isPackaged: boolean; hasAppUpdateYml: boolean }): boolean {
  return build.isPackaged && build.hasAppUpdateYml;
}

/**
 * The bytes a download of this release moves: the Mac updater fetches the
 * zip, not the DMG published beside it. Zero when the release does not say.
 */
export function updateSize(files: ReadonlyArray<{ url: string; size?: number }> | undefined): number {
  if (!files || files.length === 0) return 0;
  const zip = files.find((file) => file.url.endsWith('.zip'));
  const size = (zip ?? files[0]).size;
  return typeof size === 'number' && size > 0 ? size : 0;
}

/** Bytes as the whole megabytes the prompt reads out (decimal, as macOS counts). */
function toMB(bytes: number): number {
  return bytes > 0 ? Math.round(bytes / 1_000_000) : 0;
}

/**
 * What the user can do from the prompt (canvas `Feature - App update`):
 *
 * - `download` — Available's Download.
 * - `skip` — × on Available: that version is not offered again.
 * - `restart-now`, `restart-when-idle`, `cancel-wait` — Ready's and
 *   Waiting's buttons. Ready's single Restart is `restart-when-idle`, which
 *   restarts at once when nothing is working.
 * - `close` — × on Ready: the receipt that it installs on quit.
 * - `ok` — the receipt's OK, which ends the prompt for that version.
 */
export type UpdateAction =
  | 'download'
  | 'skip'
  | 'restart-now'
  | 'restart-when-idle'
  | 'cancel-wait'
  | 'close'
  | 'ok';

const ACTIONS: readonly UpdateAction[] = [
  'download',
  'skip',
  'restart-now',
  'restart-when-idle',
  'cancel-wait',
  'close',
  'ok',
];

/** An action off IPC, or null for anything a renderer should not have sent. */
export function parseUpdateAction(raw: unknown): UpdateAction | null {
  return ACTIONS.includes(raw as UpdateAction) ? (raw as UpdateAction) : null;
}

/**
 * What the web app is told, and all it needs to draw the prompt and the
 * Settings › Updates line. `web/src/lib/desktop.ts` has the same type.
 *
 * - `none` — nothing to show.
 * - `available` — found, not downloaded (setting off): Download, × skips.
 * - `downloading` — the download the user asked for; `percent` is whole.
 * - `ready` — downloaded. `buttons` is fixed when it appears: `one` (Restart)
 *   when nothing was working then, else `two`. `workingCount` stays live.
 * - `waiting` — restarts the first moment no Orbital session works.
 * - `closed` — × on Ready: the receipt, with OK.
 * - `restarting` — `quitAndInstall` has been called.
 *
 * `checkedAt` is when a check last completed (epoch ms), or null.
 */
export type UpdatePrompt =
  | { phase: 'none' }
  | { phase: 'available'; version: string; totalMB: number }
  | { phase: 'downloading'; version: string; percent: number; totalMB: number }
  | { phase: 'ready'; version: string; workingCount: number; buttons: 'one' | 'two' }
  | { phase: 'waiting'; version: string; workingCount: number }
  | { phase: 'closed'; version: string }
  | { phase: 'restarting'; version: string };

export type UpdateView = UpdatePrompt & { checkedAt: number | null };

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

function parsePrompt(raw: Record<string, unknown>): UpdatePrompt | null {
  const { phase, version, totalMB, percent, workingCount, buttons } = raw;
  if (phase === 'none') return { phase };
  if (typeof version !== 'string' || version === '') return null;
  switch (phase) {
    case 'available':
      return isCount(totalMB) ? { phase, version, totalMB } : null;
    case 'downloading':
      return isCount(percent) && percent <= 100 && isCount(totalMB) ? { phase, version, percent, totalMB } : null;
    case 'ready':
      return isCount(workingCount) && (buttons === 'one' || buttons === 'two')
        ? { phase, version, workingCount, buttons }
        : null;
    case 'waiting':
      return isCount(workingCount) ? { phase, version, workingCount } : null;
    case 'closed':
    case 'restarting':
      return { phase, version };
    default:
      return null;
  }
}

/** A view off IPC; anything malformed reads as no prompt, never as one. */
export function parseUpdateView(raw: unknown): UpdateView {
  if (typeof raw !== 'object' || raw === null) return { phase: 'none', checkedAt: null };
  const record = raw as Record<string, unknown>;
  const checkedAt = isCount(record.checkedAt) ? record.checkedAt : null;
  return { ...(parsePrompt(record) ?? { phase: 'none' }), checkedAt };
}

/**
 * What a Check now (Settings, or Orbital → Check for Updates…) found:
 * `unsupported` in a build that does not update itself.
 */
export type UpdateCheckAnswer =
  | { kind: 'up-to-date' }
  | { kind: 'found'; version: string }
  | { kind: 'error' }
  | { kind: 'unsupported' };

export function parseUpdateCheckAnswer(raw: unknown): UpdateCheckAnswer {
  if (typeof raw !== 'object' || raw === null) return { kind: 'error' };
  const { kind, version } = raw as Record<string, unknown>;
  if (kind === 'up-to-date' || kind === 'unsupported') return { kind };
  if (kind === 'found' && typeof version === 'string' && version !== '') return { kind, version };
  return { kind: 'error' };
}

/**
 * What the menu item says once its check is done, or null when the prompt
 * on the map already answers (found, setting off). Settings › Updates says
 * the same on its own line.
 */
export function checkAnswerMessage(
  answer: UpdateCheckAnswer,
  ctx: { current: string; autoDownload: boolean },
): { message: string; detail: string } | null {
  switch (answer.kind) {
    case 'up-to-date':
      return { message: `Orbital ${ctx.current} is up to date.`, detail: '' };
    case 'found':
      return ctx.autoDownload
        ? {
            message: `Orbital ${answer.version} found.`,
            detail: 'It is downloading; the prompt appears on the map when it is ready.',
          }
        : null;
    case 'error':
      return { message: 'Orbital could not check for updates.', detail: 'Try again later.' };
    case 'unsupported':
      return {
        message: 'This build of Orbital does not update itself.',
        detail: 'Only a released build checks GitHub for new versions.',
      };
  }
}

/**
 * What one input did, for `main.ts` to carry out: whether the view the web
 * app holds is stale, whether to call `downloadUpdate` or `quitAndInstall`
 * now, and whether the skipped version changed and must be written.
 */
export type UpdateStep = { changed: boolean; restart: boolean; download: boolean; skipChanged: boolean };

type Phase = UpdatePrompt['phase'];

/**
 * The update's state machine. The working count is `WorkingSessions.count`,
 * which already counts only Orbital-run sessions: a terminal session belongs
 * to a CLI in someone's shell, and restarting the app does not touch it. A
 * count that is not known yet counts as "not idle": waiting is safe, a
 * restart over a working session is not.
 *
 * Whether to download is decided here, not by electron-updater's
 * `autoDownload` (which `main.ts` keeps off): a skipped version must not
 * download even with the setting on, and only the flow knows which that is.
 */
export class UpdateFlow {
  private phase: Phase = 'none';
  private version = '';
  private totalMB = 0;
  private percent = 0;
  private buttons: 'one' | 'two' = 'one';
  private workingCount = 0;
  /** False until the working count has been seeded, and again after a reconnect. */
  private countKnown = false;
  private autoDownload = false;
  private checkedAt: number | null = null;
  /** × on Available. Persisted by `main.ts`; only Check now offers it again. */
  private skipped: string | null;
  /** The version whose receipt was OK'd; it installs on quit and is not offered again. */
  private dismissedVersion: string | null = null;
  /** The last version electron-updater finished downloading. */
  private downloadedVersion: string | null = null;

  constructor(init: { skippedVersion?: string | null } = {}) {
    this.skipped = init.skippedVersion ?? null;
  }

  get view(): UpdateView {
    return { ...this.prompt(), checkedAt: this.checkedAt };
  }

  get skippedVersion(): string | null {
    return this.skipped;
  }

  get autoDownloadOn(): boolean {
    return this.autoDownload;
  }

  /** Settings › Updates › Download updates automatically. */
  setAutoDownload(on: boolean): void {
    this.autoDownload = on;
  }

  /** A check completed at `at` (epoch ms). */
  checked(at: number): UpdateStep {
    const changed = this.checkedAt !== at;
    this.checkedAt = at;
    return this.step({ changed });
  }

  /**
   * A check found `version` (`update-available`). `manual` is a check the
   * user asked for, which offers a skipped version again.
   */
  available(version: string, totalBytes: number, { manual = false } = {}): UpdateStep {
    if (this.phase === 'restarting' || this.phase === 'downloading') return this.step();
    if (version === this.downloadedVersion || version === this.dismissedVersion) return this.step();
    let skipChanged = false;
    if (version === this.skipped) {
      if (!manual) return this.step();
      this.skipped = null;
      skipChanged = true;
    }
    if (this.autoDownload) return this.step({ download: true, skipChanged });
    // A prompt for a downloaded version stays: the restart installs it, and
    // the newer one is found again after.
    if (this.phase === 'ready' || this.phase === 'waiting') return this.step({ skipChanged });
    const before = this.snapshot();
    this.phase = 'available';
    this.version = version;
    this.totalMB = toMB(totalBytes);
    return this.step({ changed: before !== this.snapshot(), skipChanged });
  }

  /** `download-progress`: only a download the user asked for is shown. */
  progress(percent: number, totalBytes: number): UpdateStep {
    if (this.phase !== 'downloading') return this.step();
    const before = this.snapshot();
    this.percent = Math.min(100, Math.max(0, Math.floor(percent)));
    if (totalBytes > 0) this.totalMB = toMB(totalBytes);
    return this.step({ changed: before !== this.snapshot() });
  }

  /**
   * A download failed. One the user asked for is offered again; one that
   * ran by itself stays silent and the next check tries again.
   */
  downloadFailed(): UpdateStep {
    if (this.phase !== 'downloading') return this.step();
    this.phase = 'available';
    return this.step({ changed: true });
  }

  /** electron-updater finished downloading `version`. */
  downloaded(version: string): UpdateStep {
    if (this.phase === 'restarting') return this.step();
    if (version === this.dismissedVersion) return this.step();
    if (version === this.downloadedVersion && this.phase !== 'available' && this.phase !== 'downloading') {
      return this.step();
    }
    const before = this.snapshot();
    this.downloadedVersion = version;
    // A newer version replaces whatever was on screen, a wait or a receipt
    // included, with a prompt for it.
    this.toReady(version);
    return this.step({ changed: before !== this.snapshot() });
  }

  /**
   * The number of Orbital sessions mid-turn changed (or was re-read).
   * `seeded` is `WorkingSessions.seeded`: while it is false the count may be
   * short — the socket reconnected and the session list has not been read
   * yet — so it is not taken, and a zero never ends a wait.
   */
  setWorkingCount(count: number, seeded: boolean): UpdateStep {
    this.countKnown = seeded;
    if (!seeded) return this.step();
    const before = this.snapshot();
    this.workingCount = count;
    if (this.phase === 'waiting' && count === 0) return this.restart();
    return this.step({ changed: before !== this.snapshot() });
  }

  /** A button in the prompt; one that is not on screen in this state does nothing. */
  act(action: UpdateAction): UpdateStep {
    const before = this.snapshot();
    let download = false;
    let skipChanged = false;
    switch (`${this.phase}:${action}`) {
      case 'available:download':
        this.phase = 'downloading';
        this.percent = 0;
        download = true;
        break;
      case 'available:skip':
        this.skipped = this.version;
        this.phase = 'none';
        skipChanged = true;
        break;
      case 'ready:restart-now':
      case 'waiting:restart-now':
        return this.restart();
      case 'ready:restart-when-idle':
        if (this.countKnown && this.workingCount === 0) return this.restart();
        this.phase = 'waiting';
        break;
      case 'waiting:cancel-wait':
        // Back to the choice (canvas 4), whichever prompt the wait came from.
        this.phase = 'ready';
        this.buttons = 'two';
        break;
      case 'ready:close':
        this.phase = 'closed';
        break;
      case 'closed:ok':
        this.dismissedVersion = this.version;
        this.phase = 'none';
        break;
      default:
        return this.step();
    }
    return this.step({ changed: before !== this.snapshot(), download, skipChanged });
  }

  private toReady(version: string): void {
    this.phase = 'ready';
    this.version = version;
    this.buttons = this.countKnown && this.workingCount === 0 ? 'one' : 'two';
  }

  private prompt(): UpdatePrompt {
    const version = this.version;
    switch (this.phase) {
      case 'none':
        return { phase: 'none' };
      case 'available':
        return { phase: 'available', version, totalMB: this.totalMB };
      case 'downloading':
        return { phase: 'downloading', version, percent: this.percent, totalMB: this.totalMB };
      case 'ready':
        return { phase: 'ready', version, workingCount: this.workingCount, buttons: this.buttons };
      case 'waiting':
        return { phase: 'waiting', version, workingCount: this.workingCount };
      case 'closed':
      case 'restarting':
        return { phase: this.phase, version };
    }
  }

  private restart(): UpdateStep {
    this.phase = 'restarting';
    return { changed: true, restart: true, download: false, skipChanged: false };
  }

  private step(parts: Partial<Omit<UpdateStep, 'restart'>> = {}): UpdateStep {
    return { changed: false, download: false, skipChanged: false, ...parts, restart: false };
  }

  private snapshot(): string {
    return JSON.stringify(this.view);
  }
}
