/**
 * Where an update of this server comes from (spec
 * 2026-10-19-headless-server-design § Updating from the group). One
 * interface, three backends, chosen once at start:
 *
 * - `apt` — a headless server installed from the package: versions from
 *   `apt-cache policy orbital`, and an update is a request file the root
 *   updater's `.path` unit watches;
 * - `desktop` — a server the desktop app forked: versions from main's
 *   electron-updater, and an update is a message asking main to install;
 * - `none` — anything else (a dev server, a server started by hand).
 *
 * Nothing a caller sends reaches any of them: the request file's content is a
 * timestamp, apt-cache runs with fixed arguments, and the message to main
 * names no version.
 */
import { execFile } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseMainMessage, type MainUpdateStateMessage } from '@orbital/shared/remote/serverUpdate';
import { parseAptPolicy } from './aptPolicy.js';

/** Where the package installs the server; its entry lives under it (`server/index.mjs`). */
export const PACKAGE_ROOT = '/usr/lib/orbital';

/**
 * The directory `orbital setup` makes (root:<user>, mode 0770) and the file
 * in it the root `orbital-update.path` unit watches. Its content is ignored.
 */
export const UPDATE_REQUEST_DIR = '/var/lib/orbital/update';
export const UPDATE_REQUEST_FILE = 'request';

/** How often a headless server reads apt's view of the package again, after the read at start. */
export const UPDATE_CHECK_MS = 60 * 60_000;

/** How long `apt-cache policy` may take before it is given up on. */
export const APT_CACHE_TIMEOUT_MS = 15_000;

/** By absolute path: the PATH a server rebuilds from the login shell is the user's to change. */
const APT_CACHE = '/usr/bin/apt-cache';

export type BackendKind = 'apt' | 'desktop' | 'none';

export interface UpdateBackend {
  readonly kind: BackendKind;
  /** The installed version and the one an update would install, as last known; installed null when not known. */
  versions(): { installed: string | null; candidate: string | null };
  /** Ask for the update. `not_set_up`: a headless server whose request directory is missing. */
  request(): 'ok' | 'not_set_up';
  stop(): void;
}

/**
 * Electron's `process.parentPort` in a `utilityProcess`, as far as this
 * server uses it. Absent under plain Node.
 */
export interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  removeListener(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

/**
 * Which backend this server uses. `apt` needs both `ORBITAL_HEADLESS=1` and an
 * entry under the package root: a headless server run from a checkout has no
 * package to upgrade. `desktop` needs both the desktop app's pid and its
 * message port; a dev server the desktop attached to has neither.
 */
export function chooseUpdateBackend(o: {
  headless: boolean;
  entry: string | undefined;
  packageRoot: string;
  desktopParent: boolean;
  parentPort: boolean;
}): BackendKind {
  if (o.headless && o.entry !== undefined && resolve(o.entry).startsWith(resolve(o.packageRoot) + sep)) return 'apt';
  if (o.desktopParent && o.parentPort) return 'desktop';
  return 'none';
}

export class NoUpdateBackend implements UpdateBackend {
  readonly kind = 'none';
  versions() {
    return { installed: null, candidate: null };
  }
  request(): 'not_set_up' {
    // Never reached: the service refuses `not_packaged` first.
    return 'not_set_up';
  }
  stop(): void {}
}

/** Runs `apt-cache policy orbital` and answers its stdout; rejects on a failure or the timeout. */
export type AptCacheRun = () => Promise<string>;

export const runAptCache: AptCacheRun = () =>
  new Promise((resolvePromise, reject) => {
    execFile(
      APT_CACHE,
      ['policy', 'orbital'],
      // English labels for the parser, and nothing else of the user's environment.
      { env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, timeout: APT_CACHE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(new Error(`apt-cache: ${err.message}`));
        else resolvePromise(String(stdout));
      },
    );
  });

export class AptUpdateBackend implements UpdateBackend {
  readonly kind = 'apt';
  private installed: string | null = null;
  private candidate: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading: Promise<void> | null = null;

  constructor(private readonly opts: {
    run?: AptCacheRun;
    requestDir?: string;
    checkMs?: number;
  } = {}) {}

  /** The read at start, then one every `UPDATE_CHECK_MS`. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.checkMs ?? UPDATE_CHECK_MS);
    this.timer.unref?.();
  }

  /** One read of apt's view; a failed one keeps what was known. Never two at once. */
  refresh(): Promise<void> {
    this.reading ??= (this.opts.run ?? runAptCache)()
      .then((out) => {
        const policy = parseAptPolicy(out);
        this.installed = policy.installed;
        this.candidate = policy.candidate;
      })
      .catch((err: unknown) => {
        console.warn(`[update] apt-cache policy failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }

  versions() {
    return { installed: this.installed, candidate: this.candidate };
  }

  request(): 'ok' | 'not_set_up' {
    const dir = this.opts.requestDir ?? UPDATE_REQUEST_DIR;
    try {
      if (!statSync(dir).isDirectory()) return 'not_set_up';
      writeFileSync(join(dir, UPDATE_REQUEST_FILE), `${Date.now()}\n`);
      return 'ok';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Setup has not run, or not for this user: the directory is missing or not ours to write.
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR') return 'not_set_up';
      throw err;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * The desktop's updater, through main. Until main's first `update_state`,
 * nothing is known: installed falls back to the running version, and no
 * candidate is offered.
 */
export class DesktopUpdateBackend implements UpdateBackend {
  readonly kind = 'desktop';
  private latest: MainUpdateStateMessage | null = null;
  private readonly listener = (event: { data: unknown }) => {
    const msg = parseMainMessage(event?.data);
    if (msg) this.latest = msg;
  };

  constructor(private readonly port: ParentPort) {
    port.on('message', this.listener);
  }

  versions() {
    return { installed: this.latest?.installed ?? null, candidate: this.latest?.available ?? null };
  }

  request(): 'ok' {
    this.port.postMessage({ t: 'update_start' });
    return 'ok';
  }

  stop(): void {
    this.port.removeListener('message', this.listener);
  }
}
