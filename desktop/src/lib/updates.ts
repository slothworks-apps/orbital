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
 * launch. A tester's app is open for days. The timer does not run while the
 * Mac sleeps, so waking and coming back to a window check too
 * (`checkIsDue`); this only covers an app left in front for hours.
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The least time since the last completed check before waking the Mac or
 * coming back to an Orbital window checks again. A check reads two small
 * files off GitHub Releases, not the rate-limited API; the gap only keeps
 * switching between windows from checking on every switch.
 */
export const UPDATE_CHECK_MIN_GAP_MS = 15 * 60 * 1000;

/**
 * Whether a wake or a focus checks now. `checkedAt` is the last completed
 * check, so one that failed — a wake before the network is back — is tried
 * again at the next focus.
 */
export function checkIsDue(checkedAt: number | null, now: number): boolean {
  return checkedAt === null || now - checkedAt >= UPDATE_CHECK_MIN_GAP_MS;
}

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
 * What a check found version-wise, as the flow took it:
 *
 * - `offered` — the map shows a prompt for it now.
 * - `downloading` — downloading by itself (setting on); the prompt appears
 *   when it is ready.
 * - `installs-on-quit` — already downloaded and its prompt ended (× then
 *   OK): nothing is shown, and it installs when Orbital quits.
 * - `held` — another version is downloaded and waiting for its restart;
 *   this one is offered after it.
 * - `skipped` — skipped with ×, and the check was not one the user asked
 *   for. Never the answer to Check now, which offers it again.
 * - `none` — the app is already restarting.
 */
export type FoundOutcome = 'offered' | 'downloading' | 'installs-on-quit' | 'held' | 'skipped' | 'none';

const FOUND_OUTCOMES: readonly FoundOutcome[] = ['offered', 'downloading', 'installs-on-quit', 'held', 'skipped', 'none'];

/**
 * What a Check now (Settings, or Orbital → Check for Updates…) found:
 * `unsupported` in a build that does not update itself.
 */
export type UpdateCheckAnswer =
  | { kind: 'up-to-date' }
  | { kind: 'found'; version: string; outcome: FoundOutcome }
  | { kind: 'error' }
  | { kind: 'unsupported' };

export function parseUpdateCheckAnswer(raw: unknown): UpdateCheckAnswer {
  if (typeof raw !== 'object' || raw === null) return { kind: 'error' };
  const { kind, version, outcome } = raw as Record<string, unknown>;
  if (kind === 'up-to-date' || kind === 'unsupported') return { kind };
  if (
    kind === 'found' &&
    typeof version === 'string' &&
    version !== '' &&
    FOUND_OUTCOMES.includes(outcome as FoundOutcome)
  ) {
    return { kind, version, outcome: outcome as FoundOutcome };
  }
  return { kind: 'error' };
}

/**
 * What the menu item says once its check is done, or null when the prompt
 * on the map already answers. Settings › Updates says the same on its own
 * line (`web/src/lib/appUpdate.ts`).
 */
export function checkAnswerMessage(
  answer: UpdateCheckAnswer,
  ctx: { current: string },
): { message: string; detail: string } | null {
  switch (answer.kind) {
    case 'up-to-date':
      return { message: `Orbital ${ctx.current} is up to date.`, detail: '' };
    case 'found':
      switch (answer.outcome) {
        case 'offered':
        case 'none':
          return null;
        case 'downloading':
          return {
            message: `Orbital ${answer.version} found.`,
            detail: 'It is downloading; the prompt appears on the map when it is ready.',
          };
        case 'installs-on-quit':
          return { message: `Orbital ${answer.version} is downloaded.`, detail: 'It installs when you quit Orbital.' };
        case 'held':
        case 'skipped':
          return {
            message: `Orbital ${answer.version} found.`,
            detail: 'It is offered after Orbital restarts into the version already downloaded.',
          };
      }
      return null;
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
 * How long the working count has to stay at zero before a restart waiting
 * for sessions to finish happens. A turn's end reads `needs_input` until the
 * CLI says it is running again, so a turn the CLI starts by itself right
 * after — a message queued while it worked, a background agent reporting
 * back — reads working, not working, working within milliseconds; a restart
 * in that gap would cut the turn just starting. A couple of seconds covers
 * it and is still "the first moment" to a person.
 */
export const IDLE_SETTLE_MS = 2_000;

/**
 * What one input did, for `main.ts` to carry out: whether the view the web
 * app holds is stale, whether to call `downloadUpdate` or `quitAndInstall`
 * now, whether the skipped version changed and must be written, and whether
 * to call `idleSettled` after `IDLE_SETTLE_MS`.
 */
export type UpdateStep = {
  changed: boolean;
  restart: boolean;
  download: boolean;
  skipChanged: boolean;
  idleCheck: boolean;
};

/** `available`'s step, with what it did with the version. */
export type FoundStep = UpdateStep & { outcome: FoundOutcome };

type Phase = UpdatePrompt['phase'];

/**
 * The update's state machine. The working count is `WorkingSessions.count`,
 * the quit guard's, which counts only Orbital-run sessions that are
 * `working`: a terminal session belongs to a CLI in someone's shell, and
 * restarting the app does not touch it; a session parked on a decision (a
 * permission prompt, a question) does not hold the restart — it is
 * interrupted and continued after the update. A count that is not known yet
 * counts as "not idle": waiting is safe, a restart over a working session
 * is not.
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
  /** A version downloading by itself (setting on), so a second check does not start it again. */
  private silentDownload: string | null = null;

  constructor(init: { skippedVersion?: string | null } = {}) {
    this.skipped = init.skippedVersion ?? null;
  }

  get view(): UpdateView {
    return { ...this.prompt(), checkedAt: this.checkedAt };
  }

  get skippedVersion(): string | null {
    return this.skipped;
  }

  /**
   * Settings › Updates › Download updates automatically. Turned on while
   * Available is on screen, it downloads that version as Download would.
   */
  setAutoDownload(on: boolean): UpdateStep {
    this.autoDownload = on;
    if (on && this.phase === 'available') return this.act('download');
    return this.step();
  }

  /** A check completed at `at` (epoch ms). */
  checked(at: number): UpdateStep {
    const changed = this.checkedAt !== at;
    this.checkedAt = at;
    return this.step({ changed });
  }

  /**
   * A check found `version`. `manual` is a check the user asked for, which
   * offers a skipped version again. Safe to call twice for one check.
   */
  available(version: string, totalBytes: number, { manual = false } = {}): FoundStep {
    const found = (outcome: FoundOutcome, parts: Partial<UpdateStep> = {}): FoundStep => ({
      ...this.step(parts),
      outcome,
    });
    if (this.phase === 'restarting') return found('none');
    const shown = this.phase !== 'none' && this.version === version;
    if (shown) return found('offered');
    if (version === this.dismissedVersion) return found('installs-on-quit');
    if (version === this.downloadedVersion) return found(this.phase === 'none' ? 'installs-on-quit' : 'held');
    if (this.phase === 'downloading') return found('held');
    let skipChanged = false;
    if (version === this.skipped) {
      if (!manual) return found('skipped');
      this.skipped = null;
      skipChanged = true;
    }
    // A prompt for a downloaded version stays: the restart installs it, and
    // the newer one is found again after.
    if (this.phase === 'ready' || this.phase === 'waiting') return found('held', { skipChanged });
    if (this.autoDownload) {
      const download = this.silentDownload !== version;
      this.silentDownload = version;
      return found('downloading', { download, skipChanged });
    }
    const before = this.snapshot();
    this.phase = 'available';
    this.version = version;
    this.totalMB = toMB(totalBytes);
    return found('offered', { changed: before !== this.snapshot(), skipChanged });
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
   * `downloadUpdate()` failed — while downloading, or after `update-
   * downloaded`, when Squirrel.Mac stages the zip and can still refuse it.
   * A version on screen is offered again as Available; one that was
   * downloading by itself stays silent and the next check tries again.
   * Either way it no longer counts as downloaded.
   */
  downloadFailed(): UpdateStep {
    this.silentDownload = null;
    this.downloadedVersion = null;
    if (this.phase === 'none' || this.phase === 'available') return this.step();
    this.phase = 'available';
    return this.step({ changed: true });
  }

  /**
   * electron-updater reported an error. A failed check changes nothing; but
   * while restarting it means `quitAndInstall` did not get the app out, and
   * waiting on it would hold the prompt forever — so it counts as a failed
   * download, and the version is offered again.
   */
  updaterError(): UpdateStep {
    return this.phase === 'restarting' ? this.downloadFailed() : this.step();
  }

  /** electron-updater finished downloading `version`. */
  downloaded(version: string): UpdateStep {
    if (this.phase === 'restarting') return this.step();
    if (version === this.silentDownload) this.silentDownload = null;
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
   * yet — so it is not taken, and a zero never ends a wait. A zero during a
   * wait asks for `idleSettled` after `IDLE_SETTLE_MS` rather than
   * restarting at once.
   */
  setWorkingCount(count: number, seeded: boolean): UpdateStep {
    this.countKnown = seeded;
    if (!seeded) return this.step();
    const before = this.snapshot();
    this.workingCount = count;
    const changed = before !== this.snapshot();
    return this.step({ changed, idleCheck: this.phase === 'waiting' && count === 0 });
  }

  /** `IDLE_SETTLE_MS` after a zero: restart if the wait is still on and still nothing works. */
  idleSettled(): UpdateStep {
    if (this.phase === 'waiting' && this.countKnown && this.workingCount === 0) return this.restart();
    return this.step();
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
    return { changed: true, restart: true, download: false, skipChanged: false, idleCheck: false };
  }

  private step(parts: Partial<Omit<UpdateStep, 'restart'>> = {}): UpdateStep {
    return { changed: false, download: false, skipChanged: false, idleCheck: false, ...parts, restart: false };
  }

  private snapshot(): string {
    return JSON.stringify(this.view);
  }
}
