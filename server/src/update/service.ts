/**
 * This server's update state and the one way to start an update (spec
 * 2026-10-19-headless-server-design § Updating from the group, § Coming
 * back), over whichever backend `chooseUpdateBackend` picked.
 *
 * `updating` is set when a request is accepted and lasts until the process
 * exits — the update restarts it — or until it is known to have failed: on a
 * Mac, main's download stops without the update downloaded; anywhere,
 * `UPDATE_TIMEOUT_MS` passes with the process still here. The timeout starts
 * again with every word that the Mac is still downloading, and when it fires
 * the backend is told (`cancel`), so a download landing late does not install
 * after the members were told it failed. Failed, a new request may be made. The request is remembered in the data dir, so the next start
 * can tell whether it came back with the old version (`failed`).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  SERVER_UPDATE_REFUSALS, UPDATE_TIMEOUT_MS, updateIsNewer, type ServerUpdateRefusal, type ServerUpdateState,
  type UpdateAsker,
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
    };
  }

  /**
   * `POST /api/server/update`. Takes nothing from the request itself:
   * `startedBy` is the member the route knows asked (the channel's peer, or
   * this device), shown to the others while it updates.
   */
  start(startedBy: UpdateAsker | null = null): StartAnswer {
    const refuse = (error: ServerUpdateRefusal): StartAnswer => ({ ok: false, error, status: SERVER_UPDATE_REFUSALS[error] });
    if (this.opts.backend.kind === 'none') return refuse('not_packaged');
    if (this.updating) return refuse('updating');
    const before = this.state();
    if (!updateIsNewer(before.installed, before.candidate)) return refuse('no_update');
    if (this.opts.backend.request() === 'not_set_up') return refuse('not_set_up');
    this.updating = true;
    this.failed = null;
    this.sawProgress = false;
    const target = before.candidate as string;
    this.target = target;
    this.startedBy = startedBy;
    try {
      const marker: UpdateMarker = { from: this.opts.running, to: target, at: Date.now() };
      writeFileSync(this.opts.markerPath, `${JSON.stringify(marker)}\n`);
    } catch (err) {
      // Costs only the `failed` line after a restart that brought the old version back.
      console.warn(`[update] could not remember the request: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.armTimer();
    return { ok: true, state: this.state() };
  }

  stop(): void {
    this.clearTimer();
    this.opts.backend.stop();
  }

  private progress(progress: UpdateProgress): void {
    if (!this.updating) return;
    if (progress === 'idle') {
      // Main's download stopped without the update: failed, and nothing left installing to cancel.
      if (this.sawProgress) this.fail();
      return;
    }
    this.sawProgress = true;
    // A slow download is not a failed one: the wait starts again while it runs.
    if (progress === 'downloading') this.armTimer();
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

  private fail(): void {
    this.clearTimer();
    this.updating = false;
    this.failed = this.target;
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
