/**
 * This server's update state and the one way to start an update (spec
 * 2026-10-19-headless-server-design § Updating from the group, § Coming
 * back), over whichever backend `chooseUpdateBackend` picked.
 *
 * `updating` is set when a request is accepted and lasts until the process
 * exits — the update restarts it — or until it is known to have failed: on a
 * Mac, main's download stops without the update downloaded, or main ends the
 * request without installing (sessions started there meanwhile); anywhere,
 * `UPDATE_TIMEOUT_MS` passes with the process still here. The timeout starts
 * again with every word that the Mac is still downloading, and when it fires
 * the backend is told (`cancel`), so a download landing late does not install
 * after the members were told it failed. Failed, a new request may be made. The request is remembered in the data dir, so the next start
 * can tell whether it came back with the old version (`failed`).
 *
 * A request for `idle` (Update when sessions finish) waits first: the
 * service holds it until no session here is busy — a turn running or a
 * decision waiting — for `UPDATE_IDLE_SETTLE_MS`, then asks the backend as
 * for `now`; on a Mac, main waits itself after its download and says how
 * many sessions it waits for. The wait has no timeout of its own, it may
 * last hours: `UPDATE_TIMEOUT_MS` starts when the install does. Any member
 * may cancel it (`cancel`), and so may the person at the Mac; neither is a
 * failure. A restart of this server drops a wait it held: nothing was
 * asked of the backend and nothing was remembered, so it comes back with
 * no update running and none failed — as if it was never asked.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  SERVER_UPDATE_CANCEL_REFUSALS, SERVER_UPDATE_REFUSALS, UPDATE_TIMEOUT_MS, updateIsNewer, type ServerUpdateCancelRefusal,
  type ServerUpdateRefusal, type ServerUpdateState, type UpdateAsker, type UpdateFailReason, type UpdateWhen,
} from '@orbital/shared/remote/serverUpdate';
import type { UpdateBackend, UpdateProgress } from './backends.js';

/**
 * In the data dir: the version that asked for an update and the one it
 * asked for. Who asked is not kept: a start always ends the request that
 * wrote it, and an update that has ended names no one.
 */
export const UPDATE_MARKER_FILE = 'update-request.json';

export type UpdateMarker = { from: string; to: string; at: number };

/** The marker in `path`; null when there is none or it is malformed. Fields it does not know are ignored. */
export function readMarker(path: string): UpdateMarker | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const { from, to, at } = raw as Record<string, unknown>;
    if (typeof from !== 'string' || typeof to !== 'string' || typeof at !== 'number') return null;
    return { from, to, at };
  } catch {
    return null;
  }
}

export type StartAnswer =
  | { ok: true; state: ServerUpdateState }
  | { ok: false; error: ServerUpdateRefusal; status: number };

export type CancelAnswer =
  | { ok: true; state: ServerUpdateState }
  | { ok: false; error: ServerUpdateCancelRefusal; status: number };

/** How often a wait the service holds counts the busy sessions again. */
export const UPDATE_WAIT_CHECK_MS = 1_000;

/**
 * How long no session may be busy before a held wait installs. A turn's end
 * and the next turn the CLI starts by itself (a queued message, a background
 * agent reporting back) can be a moment apart; an install in that gap would
 * cut the turn just starting. The same reasoning, and length, as the Mac's
 * own `IDLE_SETTLE_MS`.
 */
export const UPDATE_IDLE_SETTLE_MS = 2_000;

export class UpdateService {
  private updating = false;
  private failed: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The version the running request is for. */
  private target: string | null = null;
  /** Who asked for the running request; null when nothing runs, or the asker is not known. */
  private startedBy: UpdateAsker | null = null;
  /** The backend said it is downloading (or done) since the request: an idle word after it means the download failed. */
  private sawProgress = false;
  /** The last progress the backend reported, request or not: a request that joins a running download has seen it. */
  private lastProgress: UpdateProgress = 'idle';
  /** Why the last request failed, when the backend said (`ServerUpdateState.failedReason`). */
  private failedReason: UpdateFailReason | null = null;
  /** When the running request installs. */
  private when: UpdateWhen = 'now';
  /** The service holds an `idle` request until no session is busy; null when it holds none. */
  private held: { by: UpdateAsker | null; timer: ReturnType<typeof setInterval>; idleSince: number | null } | null = null;
  /** The backend said it waits (`waiting`) for the running `idle` request. */
  private sawWaiting = false;
  /** The running `idle` request is past its wait and installs. */
  private installing = false;

  constructor(private readonly opts: {
    backend: UpdateBackend;
    /** The version this process runs (`ORBITAL_VERSION`, else `dev`). */
    running: string;
    /** Where the marker lives (`<dataDir>/update-request.json`). */
    markerPath: string;
    /** How many sessions this server is running now. */
    sessions: () => number;
    timeoutMs?: number;
  }) {
    opts.backend.onProgress((progress) => this.progress(progress));
    // A start always ends the request that wrote the marker: it came back
    // on the new version, or on the old one, failed.
    const marker = readMarker(opts.markerPath);
    if (marker === null) return;
    if (marker.from === opts.running) {
      // Back, or still here, with the version that asked: the update did not happen.
      this.failed = marker.to;
    } else {
      // Another version than the one that asked: it happened, by this request or by hand.
      this.forgetMarker();
    }
  }

  state(): ServerUpdateState {
    const { installed, candidate } = this.opts.backend.versions();
    return {
      installed: installed ?? this.opts.running,
      candidate,
      packaged: this.opts.backend.kind !== 'none',
      updating: this.updating,
      failed: this.failed,
      sessions: this.opts.sessions(),
      startedBy: this.updating ? this.startedBy : null,
      failedReason: this.failed !== null ? this.failedReason : null,
      waiting: this.waitingFor(),
    };
  }

  /**
   * How many sessions the running request waits for: the busy ones here
   * while the service holds it, the Mac's word while main waits (the busy
   * ones here until main has said). Null when nothing waits.
   */
  private waitingFor(): { sessions: number } | null {
    if (!this.updating || this.when !== 'idle' || this.installing) return null;
    if (this.held) return { sessions: this.opts.sessions() };
    if (!this.opts.backend.waitsItself) return null;
    return { sessions: this.opts.backend.waiting() ?? this.opts.sessions() };
  }

  /**
   * `POST /api/server/update`. Takes nothing from the request itself but
   * `when` (`parseUpdateStartBody`): `startedBy` is the member the route
   * knows asked (the channel's peer, or this device), shown to the others
   * while it updates. `fromPeer`: it came through a member's channel, so the
   * backend is told who (a Mac names it on its prompt); a request made on
   * this device is its own update there. `when` `idle` with sessions busy
   * here waits for them (see the class doc); with none, it starts at once.
   */
  start(
    startedBy: UpdateAsker | null = null,
    { fromPeer = false, when = 'now' }: { fromPeer?: boolean; when?: UpdateWhen } = {},
  ): StartAnswer {
    const refuse = (error: ServerUpdateRefusal): StartAnswer => ({ ok: false, error, status: SERVER_UPDATE_REFUSALS[error] });
    if (this.opts.backend.kind === 'none') return refuse('not_packaged');
    if (this.updating) return refuse('updating');
    const before = this.state();
    if (!updateIsNewer(before.installed, before.candidate)) return refuse('no_update');
    const by = fromPeer ? startedBy : null;
    const hold = when === 'idle' && !this.opts.backend.waitsItself && this.opts.sessions() > 0;
    if (hold) {
      // Refused now rather than at the end of a wait that may last hours.
      if (this.opts.backend.ready() === 'not_set_up') return refuse('not_set_up');
    } else if (this.opts.backend.request(by, this.opts.backend.waitsItself ? when : 'now') === 'not_set_up') {
      return refuse('not_set_up');
    }
    this.updating = true;
    this.failed = null;
    this.failedReason = null;
    // Main's download already running counts as progress, so its failing (`idle`) fails this request too.
    this.sawProgress = this.lastProgress === 'downloading' || this.lastProgress === 'downloaded';
    this.target = before.candidate;
    this.startedBy = startedBy;
    this.when = when;
    this.sawWaiting = false;
    this.installing = false;
    if (hold) {
      this.held = { by, timer: setInterval(() => this.checkHeld(), UPDATE_WAIT_CHECK_MS), idleSince: null };
      this.held.timer.unref?.();
      return { ok: true, state: this.state() };
    }
    // Main's wait is remembered only once its install starts (`progress`): a restart during it drops it.
    if (when === 'now' || !this.opts.backend.waitsItself) this.remember();
    // Until main says it waits, as for `now`: a request it never took fails at the timeout.
    this.armTimer();
    return { ok: true, state: this.state() };
  }

  /**
   * `DELETE /api/server/update`: ends a wait for the sessions, whoever
   * started it; `not_waiting` when none runs — an install already under way
   * cannot be called back. Not a failure: no `failed` follows, and the
   * member offers the update again.
   */
  cancel(): CancelAnswer {
    if (this.waitingFor() === null) {
      return { ok: false, error: 'not_waiting', status: SERVER_UPDATE_CANCEL_REFUSALS.not_waiting };
    }
    const mainWaits = this.held === null;
    this.endWait();
    // Main stops waiting, and keeps what it downloaded as its own update.
    if (mainWaits) this.opts.backend.cancel();
    return { ok: true, state: this.state() };
  }

  stop(): void {
    this.clearTimer();
    this.stopHeld();
    this.opts.backend.stop();
  }

  private progress(progress: UpdateProgress): void {
    if (typeof progress === 'string') this.lastProgress = progress;
    if (!this.updating) return;
    if (typeof progress === 'object') {
      // The person at the Mac cancelled its wait: not a failure.
      if (progress.ended === 'cancelled') {
        if (this.when === 'idle') this.endWait();
        return;
      }
      // Main ended the request without installing: failed now, not at the timeout.
      this.fail(progress.ended === 'restart' ? null : progress.ended);
      return;
    }
    if (this.when === 'idle' && this.opts.backend.waitsItself && !this.installing) {
      if (this.opts.backend.waiting() !== null) {
        // Main waits for its sessions: no time runs out on that.
        this.sawWaiting = true;
        if (progress !== 'idle') this.sawProgress = true;
        this.clearTimer();
        return;
      }
      if (this.sawWaiting) {
        // Its wait ended in the install: from here as for `now`.
        this.installing = true;
        this.remember();
        this.armTimer();
      }
    }
    if (progress === 'idle') {
      // Main's download stopped without the update: failed, and nothing left installing to cancel.
      if (this.sawProgress) this.fail();
      return;
    }
    this.sawProgress = true;
    // A slow download is not a failed one: the wait starts again with every
    // word that it runs, which main repeats while it moves (`UPDATE_KEEPALIVE_MS`).
    if (progress === 'downloading') this.armTimer();
  }

  /** A held wait, counted again: it installs once no session has been busy for `UPDATE_IDLE_SETTLE_MS`. */
  private checkHeld(): void {
    const held = this.held;
    if (!held) return;
    if (this.opts.sessions() > 0) {
      held.idleSince = null;
      return;
    }
    const now = Date.now();
    held.idleSince ??= now;
    if (now - held.idleSince < UPDATE_IDLE_SETTLE_MS) return;
    this.stopHeld();
    if (this.opts.backend.request(held.by, 'now') === 'not_set_up') {
      // Setup was undone during the wait.
      this.fail();
      return;
    }
    this.installing = true;
    this.remember();
    this.armTimer();
  }

  private stopHeld(): void {
    if (this.held) clearInterval(this.held.timer);
    this.held = null;
  }

  /** A wait that ended without the install: nothing failed, nothing is remembered. */
  private endWait(): void {
    this.clearTimer();
    this.stopHeld();
    this.updating = false;
    this.startedBy = null;
    this.sawProgress = false;
    this.sawWaiting = false;
    this.installing = false;
    this.when = 'now';
    this.forgetMarker();
  }

  /** Writes the marker: the request is out, and the next start tells whether it brought the new version. */
  private remember(): void {
    try {
      const marker: UpdateMarker = { from: this.opts.running, to: this.target as string, at: Date.now() };
      writeFileSync(this.opts.markerPath, `${JSON.stringify(marker)}\n`);
    } catch (err) {
      // Costs only the `failed` line after a restart that brought the old version back.
      console.warn(`[update] could not remember the request: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private armTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fail();
      this.opts.backend.cancel();
    }, this.opts.timeoutMs ?? UPDATE_TIMEOUT_MS);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private fail(reason: UpdateFailReason | null = null): void {
    this.clearTimer();
    this.stopHeld();
    this.updating = false;
    this.when = 'now';
    this.installing = false;
    this.sawWaiting = false;
    this.failed = this.target;
    this.failedReason = reason;
    this.startedBy = null;
    this.sawProgress = false;
  }

  private forgetMarker(): void {
    try {
      rmSync(this.opts.markerPath, { force: true });
    } catch {
      /* a marker that stays only says failed after a later restart of this same version, which it was */
    }
  }
}
