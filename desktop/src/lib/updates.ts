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

import {
  UPDATE_KEEPALIVE_MS, type MainUpdateStateMessage, type UpdateEndReason, type UpdateWhen,
} from '@orbital/shared/remote/serverUpdate';

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
 * How long the last line of an update another member started (canvas 50v
 * 02, "Restarting on … · started on …") stays on this Mac before Orbital
 * quits into the update: long enough to be read by someone at the Mac, never
 * shown as a number. A session started meanwhile does not hold it.
 */
export const REMOTE_RESTART_HOLD_MS = 3_000;

/**
 * The file in `userData`, beside `SKIPPED_VERSION_FILE`, that carries an
 * update another member started across the restart it made: who, when, how
 * many sessions it stopped, and the version it installed. The relaunched
 * app says so once (canvas 50v 04) and removes it when that is dismissed.
 * Main is its only reader and writer.
 */
export const UPDATE_RECEIPT_FILE = 'update-receipt.json';

/** An update another member made of this Mac, as the relaunched app tells it (`UPDATE_RECEIPT_FILE`). */
export type UpdateReceipt = {
  /** The member's name, as the request named it. */
  by: string;
  /** When the restart was made (epoch ms). */
  at: number;
  /** How many Orbital sessions were working then, and stopped. */
  stopped: number;
  /** The version it restarted into. */
  version: string;
};

function isReceipt(raw: unknown): raw is UpdateReceipt {
  if (typeof raw !== 'object' || raw === null) return false;
  const { by, at, stopped, version } = raw as Record<string, unknown>;
  return typeof by === 'string' && by !== '' && isCount(at) && isCount(stopped) && typeof version === 'string' && version !== '';
}

export function parseUpdateReceipt(raw: string): UpdateReceipt | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isReceipt(parsed)) return null;
    const { by, at, stopped, version } = parsed;
    return { by, at, stopped, version };
  } catch {
    return null;
  }
}

export function serializeUpdateReceipt(receipt: UpdateReceipt): string {
  return `${JSON.stringify(receipt)}\n`;
}

/**
 * The receipt a launch tells, from the file it found: only one for the
 * version this launch runs. Another version means the restart did not bring
 * it — the install failed, or it is older than an update since — and it is
 * dropped unsaid.
 */
export function receiptAtLaunch(receipt: UpdateReceipt | null, running: string): UpdateReceipt | null {
  return receipt !== null && receipt.version === running ? receipt : null;
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
 * - `receipt-close` — × on the line saying another member updated this Mac
 *   (`UpdateView.receipt`): it is not said again.
 */
export type UpdateAction =
  | 'download'
  | 'skip'
  | 'restart-now'
  | 'restart-when-idle'
  | 'cancel-wait'
  | 'close'
  | 'ok'
  | 'receipt-close';

const ACTIONS: readonly UpdateAction[] = [
  'download',
  'skip',
  'restart-now',
  'restart-when-idle',
  'cancel-wait',
  'close',
  'ok',
  'receipt-close',
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
 *
 * An update another member of the group started (canvas 50v) adds:
 *
 * - `remote` — while it downloads, waits and restarts here: the member's
 *   name, how many Orbital sessions work now (live), which the restart
 *   stops, and `wait` when it was asked to install once they finish (canvas
 *   50v 02), the wait shown from the download on. Null otherwise, and for an
 *   update started on this Mac (its web, the CLI).
 * - `sessionStarted` — on Ready, when that update did not install because a
 *   session started here while it downloaded: it waits for this Mac's user.
 * - `receipt` — after the restart it made, until × on its line: who, when,
 *   how many sessions it stopped.
 */
export type UpdatePrompt =
  | { phase: 'none' }
  | { phase: 'available'; version: string; totalMB: number }
  | { phase: 'downloading'; version: string; percent: number; totalMB: number }
  | { phase: 'ready'; version: string; workingCount: number; buttons: 'one' | 'two' }
  | { phase: 'waiting'; version: string; workingCount: number }
  | { phase: 'closed'; version: string }
  | { phase: 'restarting'; version: string };

export type UpdateRemote = { by: string; working: number; wait: boolean };

export type UpdateView = UpdatePrompt & {
  checkedAt: number | null;
  remote: UpdateRemote | null;
  sessionStarted: boolean;
  receipt: UpdateReceipt | null;
};

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

function parseRemote(raw: unknown): UpdateRemote | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { by, working, wait } = raw as Record<string, unknown>;
  return typeof by === 'string' && by !== '' && isCount(working) ? { by, working, wait: wait === true } : null;
}

/** The phases a member's update shows in (canvas 50v 01–03). */
const REMOTE_PHASES: ReadonlySet<UpdatePrompt['phase']> = new Set(['downloading', 'waiting', 'restarting']);

const NO_UPDATE: UpdateView = { phase: 'none', checkedAt: null, remote: null, sessionStarted: false, receipt: null };

/**
 * A view off IPC; anything malformed reads as no prompt, never as one. A
 * malformed `remote` or `receipt` reads as none: the prompt is then this
 * Mac's own, and the receipt unsaid.
 */
export function parseUpdateView(raw: unknown): UpdateView {
  if (typeof raw !== 'object' || raw === null) return NO_UPDATE;
  const record = raw as Record<string, unknown>;
  const checkedAt = isCount(record.checkedAt) ? record.checkedAt : null;
  const prompt = parsePrompt(record);
  if (prompt === null) return { ...NO_UPDATE, checkedAt };
  const receipt = isReceipt(record.receipt)
    ? { by: record.receipt.by, at: record.receipt.at, stopped: record.receipt.stopped, version: record.receipt.version }
    : null;
  return {
    ...prompt,
    checkedAt,
    remote: REMOTE_PHASES.has(prompt.phase) ? parseRemote(record.remote) : null,
    sessionStarted: prompt.phase === 'ready' && record.sessionStarted === true,
    receipt,
  };
}

/**
 * What a check found version-wise, as the flow took it:
 *
 * - `offered` — the map shows a prompt for it now.
 * - `waiting` — downloaded, and Orbital restarts into it when the working
 *   sessions finish; nothing is on the map.
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
export type FoundOutcome = 'offered' | 'waiting' | 'downloading' | 'installs-on-quit' | 'held' | 'skipped' | 'none';

const FOUND_OUTCOMES: readonly FoundOutcome[] = ['offered', 'waiting', 'downloading', 'installs-on-quit', 'held', 'skipped', 'none'];

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
        case 'waiting':
          return {
            message: `Orbital ${answer.version} is downloaded.`,
            detail: 'Orbital restarts into it when the working sessions finish.',
          };
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
 * now, whether the skipped version changed and must be written, whether
 * to call `idleSettled` after `IDLE_SETTLE_MS`, and whether to tell the
 * server a member's request ended here without the install (`update_ended`,
 * with the reason).
 *
 * `holdMs`: above 0, a member's restart is holding its last line — call
 * `holdEnded` after that long, which says `restart` (`quitAndInstall` now).
 * `receipt`: write this receipt to `UPDATE_RECEIPT_FILE`, or remove the file
 * (`clear`); null leaves it.
 */
export type UpdateStep = {
  changed: boolean;
  restart: boolean;
  holdMs: number;
  download: boolean;
  skipChanged: boolean;
  idleCheck: boolean;
  remoteEnded: UpdateEndReason | null;
  receipt: UpdateReceipt | 'clear' | null;
};

/** `available`'s step, with what it did with the version. */
export type FoundStep = UpdateStep & { outcome: FoundOutcome };

type Phase = UpdatePrompt['phase'];

/**
 * The update's state machine. The working count is
 * `WorkingSessions.busyCount`: Orbital-run sessions mid-turn or waiting on a
 * decision (a permission prompt, a question), the server's `Runner.busy`
 * rule — a wait for the sessions to finish waits for those too. A terminal
 * session belongs to a CLI in someone's shell, and restarting the app does
 * not touch it. A count that is not known yet
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
  /** The working sessions' ids, as last given with the count; their number is the count when both are known. */
  private workingIds: readonly string[] = [];
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
  /** The version the last check found, whatever the prompt did with it: what a member may ask to install. */
  private found: string | null = null;
  /**
   * Another member of the group asked for the update (`update_start`): once
   * it is downloaded it installs at once, rather than prompting here.
   */
  private remoteRequested = false;
  /**
   * The sessions working when the member's request arrived, by id: the
   * member confirmed the sessions running before it asked, so only a session
   * working at the landing that is not among these — one that started while
   * it downloaded — keeps the download from installing. Null when they were
   * not known then.
   */
  private remoteBaseline: ReadonlySet<string> | null = null;
  /** A member's request already retried a restart that had not got the app out (`remoteStart`). */
  private restartRetried = false;
  /**
   * The running request asked to install once the sessions here finish
   * (`when: 'idle'`): it downloads, then waits as Restart when sessions
   * finish does, for every session — no new-turn rule. Main tells the server
   * the count it waits for (`serverState`).
   */
  private remoteWait = false;
  /**
   * The member a running request came from, by name, for the prompt (canvas
   * 50v); null for a request made on this Mac and when none runs.
   */
  private remoteBy: string | null = null;
  /** Ready came from a member's request that a session started here declined (canvas 50v 03). */
  private sessionStarted = false;
  /** The receipt this launch tells (`UpdateView.receipt`), until × on it. */
  private receipt: UpdateReceipt | null;
  /** A receipt was written for a restart that has not got the app out yet. */
  private receiptWritten = false;
  /**
   * A member's restart is holding its last line (`REMOTE_RESTART_HOLD_MS`):
   * restarting, but `quitAndInstall` not called yet (`holdEnded`).
   */
  private holding = false;
  private readonly now: () => number;

  constructor(init: { skippedVersion?: string | null; receipt?: UpdateReceipt | null; now?: () => number } = {}) {
    this.skipped = init.skippedVersion ?? null;
    this.receipt = init.receipt ?? null;
    this.now = init.now ?? Date.now;
  }

  get view(): UpdateView {
    const prompt = this.prompt();
    const remote = this.remoteBy !== null && REMOTE_PHASES.has(prompt.phase)
      ? { by: this.remoteBy, working: this.workingCount, wait: this.remoteWait }
      : null;
    return {
      ...prompt,
      checkedAt: this.checkedAt,
      remote,
      sessionStarted: this.sessionStarted && prompt.phase === 'ready',
      receipt: this.receipt,
    };
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
    this.found = version;
    const shown = this.phase !== 'none' && this.version === version;
    if (shown) return found(this.phase === 'waiting' ? 'waiting' : 'offered');
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
    // A member's restart abandoned: the members are told at once, not at the server's timeout.
    const remoteEnded = this.phase === 'restarting' && this.remoteBy !== null ? 'restart' : null;
    this.silentDownload = null;
    this.remoteRequested = false;
    this.remoteWait = false;
    this.restartRetried = false;
    this.holding = false;
    this.downloadedVersion = null;
    this.remoteBy = null;
    // A restart that did not happen made no update to tell of.
    const receipt = this.receiptWritten ? 'clear' : null;
    this.receiptWritten = false;
    if (this.phase === 'none' || this.phase === 'available') return this.step({ receipt, remoteEnded });
    this.phase = 'available';
    return this.step({ changed: true, receipt, remoteEnded });
  }

  /**
   * electron-updater reported an error. A failed check changes nothing; but
   * while restarting it means `quitAndInstall` did not get the app out, and
   * waiting on it would hold the prompt forever — so it counts as a failed
   * download, and the version is offered again. Not while a member's
   * restart holds its last line: `quitAndInstall` has not been called, so
   * the error is a check's, not the install's.
   */
  updaterError(): UpdateStep {
    return this.phase === 'restarting' && !this.holding ? this.downloadFailed() : this.step();
  }

  /** The version the app is restarting into, its hold included, else null: no check runs then. */
  get restartingInto(): string | null {
    return this.phase === 'restarting' ? this.version : null;
  }

  /**
   * `REMOTE_RESTART_HOLD_MS` after a member's restart began: `quitAndInstall`
   * now, and the receipt for the relaunched app, counting the sessions this
   * restart stops. Nothing when the hold was abandoned meanwhile.
   */
  holdEnded(): UpdateStep {
    if (!this.holding || this.phase !== 'restarting' || this.remoteBy === null) return this.step();
    this.holding = false;
    this.receiptWritten = true;
    return {
      ...this.step(),
      restart: true,
      receipt: {
        by: this.remoteBy,
        at: this.now(),
        stopped: this.countKnown ? this.workingCount : 0,
        version: this.version,
      },
    };
  }

  /**
   * electron-updater finished downloading `version`. A member's request
   * comes first, a version whose receipt was OK'd here included: it installs
   * now, unless a session is working that was not when the request arrived
   * (`sessions`), or which sessions work cannot be told (`unknown`) — then it
   * does not restart over them, prompts here as this Mac's own download
   * would, and tells the server the request ended (`remoteEnded`).
   */
  downloaded(version: string): UpdateStep {
    if (this.phase === 'restarting') return this.step();
    if (version === this.silentDownload) this.silentDownload = null;
    if (this.remoteRequested) {
      this.remoteRequested = false;
      const before = this.snapshot();
      this.downloadedVersion = version;
      // Asked to wait for the sessions: no verdict, it waits for every one of them.
      if (this.remoteWait) return this.waitForSessions(version, before);
      const ended = this.remoteVerdict();
      if (ended === null) {
        this.version = version;
        return this.restart();
      }
      // From here it is this Mac's own update, waiting for its user.
      const fromMember = this.remoteBy !== null;
      this.remoteBy = null;
      this.toReady(version);
      this.sessionStarted = fromMember && ended === 'sessions';
      return this.step({ changed: before !== this.snapshot(), remoteEnded: ended });
    }
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
   * restarting at once. `ids` are the working sessions themselves
   * (`WorkingSessions.workingIds`), which a member's request is judged by.
   */
  setWorkingCount(count: number, seeded: boolean, ids: readonly string[] = []): UpdateStep {
    this.countKnown = seeded;
    if (!seeded) return this.step();
    const before = this.snapshot();
    this.workingCount = count;
    this.workingIds = ids;
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
    if (action === 'receipt-close') {
      if (this.receipt === null) return this.step();
      this.receipt = null;
      return this.step({ changed: true, receipt: 'clear' });
    }
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
      case 'waiting:cancel-wait': {
        // Back to the choice (canvas 4), whichever prompt the wait came from.
        // A member's wait cancelled here ends its request (canvas 50v 02): not a failure.
        const remoteEnded = this.remoteWait ? 'cancelled' : null;
        this.remoteWait = false;
        this.remoteBy = null;
        this.phase = 'ready';
        this.buttons = 'two';
        this.sessionStarted = false;
        return this.step({ changed: before !== this.snapshot(), remoteEnded });
      }
      case 'downloading:cancel-wait': {
        // A member's wait cancelled while it still downloads: the download
        // goes on as this Mac's own, and lands as its Ready.
        if (!this.remoteWait) return this.step();
        this.remoteWait = false;
        this.remoteRequested = false;
        this.remoteBy = null;
        return this.step({ changed: before !== this.snapshot(), remoteEnded: 'cancelled' });
      }
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
    // Whatever the user chose on the prompt, it is their own update now.
    this.sessionStarted = false;
    return this.step({ changed: before !== this.snapshot(), download, skipChanged });
  }

  /**
   * A member of the group asked for the update (spec
   * 2026-10-19-headless-server-design § A Mac, too): what Download and then
   * Restart would do, without waiting on this Mac's user, who did not ask.
   * The member confirmed the running sessions before it asked. Downloaded
   * already, it installs now; otherwise the version found downloads — shown
   * as downloading here too, a skip of it undone — and installs once
   * downloaded. With nothing found, nothing happens.
   *
   * Asked while already restarting, the restart did not get the app out (no
   * error came, or the quit was held): it is tried once more — a member
   * asking is someone waiting on it, and a second `quitAndInstall` is
   * harmless — and asked again after that, the request ends at once
   * (`remoteEnded: 'restart'`) rather than waiting out the server's timeout.
   *
   * `by` names the member that asked through its channel (canvas 50v): the
   * download shows as theirs here, a silent one included, and its restart
   * holds its last line `REMOTE_RESTART_HOLD_MS` and leaves a receipt for
   * the relaunched app. Null — asked on this Mac — shows as its own update.
   *
   * `when` `idle` (Update when sessions finish, canvas 50v 02): once
   * downloaded it waits, as Restart when sessions finish does, for every
   * working session here — a new turn meanwhile is waited for, not a reason
   * to stop — and restarts the first moment none works. Its Cancel, here or
   * on any member, leaves the download as this Mac's own Ready.
   */
  remoteStart(by: string | null = null, when: UpdateWhen = 'now'): UpdateStep {
    if (this.phase === 'restarting') {
      // The hold ends in the install by itself.
      if (this.holding) return this.step();
      if (this.restartRetried) {
        // A member's restart that never got the app out: no false last line, this Mac's Ready instead.
        if (this.remoteBy !== null) return this.abandonRemoteRestart('restart');
        return this.step({ remoteEnded: 'restart' });
      }
      this.restartRetried = true;
      return this.restart({ retry: true });
    }
    this.sessionStarted = false;
    if (this.downloadedVersion !== null) {
      this.remoteBy = by;
      this.version = this.downloadedVersion;
      if (when === 'idle') return this.waitForSessions(this.downloadedVersion, this.snapshot());
      return this.restart();
    }
    const version = this.phase !== 'none' ? this.version : (this.silentDownload ?? this.found);
    if (version === null || version === '') return this.step();
    const before = this.snapshot();
    this.remoteRequested = true;
    this.remoteWait = when === 'idle';
    this.remoteBy = by;
    this.remoteBaseline = this.idsKnown() ? new Set(this.workingIds) : null;
    if (this.phase === 'downloading') return this.step({ changed: before !== this.snapshot() });
    if (this.silentDownload === version) {
      // Downloading by itself, unseen: a member's download is shown here, so it is from now on.
      if (by === null) return this.step();
      this.phase = 'downloading';
      this.version = version;
      this.percent = 0;
      return this.step({ changed: true });
    }
    let skipChanged = false;
    if (this.skipped === version) {
      this.skipped = null;
      skipChanged = true;
    }
    this.phase = 'downloading';
    this.version = version;
    this.percent = 0;
    return this.step({ changed: before !== this.snapshot(), download: true, skipChanged });
  }

  /**
   * The server gave up on a member's request (`update_cancel`) and told the
   * members it failed: a download still running lands as any download does,
   * with the prompt, rather than installing by itself.
   */
  remoteCancel(): UpdateStep {
    this.remoteRequested = false;
    if (this.remoteWait) {
      // A member cancelled the wait (or the server gave up before main took it):
      // the download stays, as this Mac's own — its Ready once downloaded.
      const before = this.snapshot();
      this.remoteWait = false;
      this.remoteBy = null;
      if (this.phase === 'waiting') this.toReady(this.version);
      return this.step({ changed: before !== this.snapshot() });
    }
    if (this.remoteBy === null) return this.step();
    // The members were told it failed: a restart that has not got the app out
    // (or is still holding) gives way to this Mac's Ready.
    if (this.phase === 'restarting') return this.abandonRemoteRestart(null);
    // Still downloading: from here it is this Mac's own download, and says so.
    this.remoteBy = null;
    return this.step({ changed: true });
  }

  /**
   * What the forked server is told (`update_state`): the version a member
   * would install — the one downloaded, else the one on screen or
   * downloading, else the last found — and how far along it is.
   */
  serverState(installed: string): MainUpdateStateMessage {
    const shown = this.phase !== 'none' && this.phase !== 'restarting' ? this.version : null;
    const available = this.downloadedVersion ?? shown ?? this.silentDownload ?? this.found;
    return {
      t: 'update_state',
      installed,
      available: available !== null && available !== installed ? available : null,
      downloading: this.phase === 'downloading' || this.silentDownload !== null,
      downloaded: this.downloadedVersion !== null,
      waiting: this.remoteWait ? this.workingCount : null,
    };
  }

  /**
   * A member's `idle` request, downloaded: wait for the sessions here, or
   * restart now when none works. `before` is the view before the input that
   * led here.
   */
  private waitForSessions(version: string, before: string): UpdateStep {
    this.remoteWait = true;
    this.phase = 'waiting';
    this.version = version;
    if (this.countKnown && this.workingCount === 0) return this.restart();
    return this.step({ changed: before !== this.snapshot() });
  }

  /** Whether the working sessions are known by id: seeded, and the ids given with the count. */
  private idsKnown(): boolean {
    return this.countKnown && this.workingIds.length === this.workingCount;
  }

  /**
   * Whether a member's download that just landed may install: null when it
   * may — nothing works that did not when the request arrived — else why not.
   */
  private remoteVerdict(): Exclude<UpdateEndReason, 'restart'> | null {
    if (!this.idsKnown()) return 'unknown';
    if (this.workingIds.length === 0) return null;
    if (this.remoteBaseline === null) return 'unknown';
    const baseline = this.remoteBaseline;
    return this.workingIds.every((id) => baseline.has(id)) ? null : 'sessions';
  }

  private toReady(version: string): void {
    this.phase = 'ready';
    this.version = version;
    this.buttons = this.countKnown && this.workingCount === 0 ? 'one' : 'two';
    this.sessionStarted = false;
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

  /**
   * Into the update. One a member started holds its last line first: no
   * `quitAndInstall` yet, `holdEnded` after `holdMs` makes it and writes the
   * receipt. A retry of a restart already made goes at once, its receipt
   * already written.
   */
  private restart({ retry = false }: { retry?: boolean } = {}): UpdateStep {
    this.phase = 'restarting';
    this.sessionStarted = false;
    // A wait ends in the install.
    this.remoteWait = false;
    const step: UpdateStep = {
      changed: true, restart: true, holdMs: 0, download: false, skipChanged: false, idleCheck: false,
      remoteEnded: null, receipt: null,
    };
    if (retry || this.remoteBy === null) return step;
    this.holding = true;
    return { ...step, restart: false, holdMs: REMOTE_RESTART_HOLD_MS };
  }

  /**
   * A member's restart that will not happen — its retry spent, or the server
   * gave up on it: the downloaded version back as this Mac's own Ready, the
   * receipt taken back, and the server told when it does not know yet.
   */
  private abandonRemoteRestart(remoteEnded: UpdateEndReason | null): UpdateStep {
    const receipt = this.receiptWritten ? 'clear' : null;
    this.receiptWritten = false;
    this.holding = false;
    this.restartRetried = false;
    this.remoteBy = null;
    this.toReady(this.downloadedVersion ?? this.version);
    return this.step({ changed: true, receipt, remoteEnded });
  }

  private step(parts: Partial<Omit<UpdateStep, 'restart'>> = {}): UpdateStep {
    return {
      changed: false, download: false, skipChanged: false, idleCheck: false, remoteEnded: null, receipt: null,
      holdMs: 0, ...parts, restart: false,
    };
  }

  private snapshot(): string {
    return JSON.stringify(this.view);
  }
}

/** The last `update_state` sent to the server: its JSON and when (epoch ms). */
export type SentServerState = { json: string; at: number };

/**
 * Whether main sends the server `update_state` now: when it changed since the
 * last one, and while it downloads, again every `UPDATE_KEEPALIVE_MS` even
 * when it did not — the server's wait starts over with each word. Main calls
 * this on every step, a download's progress included, so the word repeats
 * only while the download moves; a download that stalls says nothing, and
 * the server's wait runs out.
 */
export function serverStateDue(last: SentServerState | null, json: string, downloading: boolean, now: number): boolean {
  if (last === null || last.json !== json) return true;
  return downloading && now - last.at >= UPDATE_KEEPALIVE_MS;
}
