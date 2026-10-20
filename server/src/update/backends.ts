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
import { closeSync, constants, lstatSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  STARTED_BY_ID_MAX_CHARS, STARTED_BY_NAME_MAX_CHARS, isUpdateVersion, parseMainMessage, type MainUpdateStateMessage,
  type ServerUpdateMessage, type UpdateAsker, type UpdateEndReason, type UpdateWhen,
} from '@orbital/shared/remote/serverUpdate';
import { parseAptPolicy } from './aptPolicy.js';

/** Where the package installs the server; its entry lives under it (`server/index.mjs`). */
export const PACKAGE_ROOT = '/usr/lib/orbital';

/**
 * The file under `PACKAGE_ROOT` that holds the package's version. The
 * server reads it at start instead of the unit carrying `ORBITAL_VERSION`:
 * `postinst` restarts the user unit, and a value in the unit would stay the
 * old one until a `daemon-reload`, so a successful update would read as
 * failed.
 */
export const PACKAGE_VERSION_FILE = 'VERSION';

/**
 * The directory `orbital setup` makes (<user>:root, mode 0700) and the file
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

/**
 * How far the desktop's updater is with a download, or that the request
 * ended there without the install (`ended`, with main's reason); apt and
 * none report nothing.
 */
export type UpdateProgress = 'downloading' | 'downloaded' | 'idle' | { ended: UpdateEndReason };

export interface UpdateBackend {
  readonly kind: BackendKind;
  /**
   * The backend waits for the sessions itself when asked for `idle` (the
   * desktop's updater, which waits after its download, canvas 50v 02); else
   * the service holds the request until no session is busy, then asks for it
   * `now`.
   */
  readonly waitsItself: boolean;
  /** The installed version and the one an update would install, as last known; installed null when not known. */
  versions(): { installed: string | null; candidate: string | null };
  /**
   * Whether a request could be made now: `not_set_up` for a headless server
   * whose request directory is missing. Asked before a wait is accepted, so a
   * wait does not last hours to fail at its end.
   */
  ready(): 'ok' | 'not_set_up';
  /**
   * Ask for the update. `by`: the member that asked through its channel,
   * null for a request made on this device; only the desktop's updater uses
   * it, to name that member on its prompt. `when`: only a backend that
   * `waitsItself` is ever asked for `idle`. `not_set_up`: a headless server
   * whose request directory is missing.
   */
  request(by: UpdateAsker | null, when: UpdateWhen): 'ok' | 'not_set_up';
  /**
   * While a request asked for `idle` waits in the backend, how many sessions
   * it waits for; null when none waits there (or the backend never waits).
   */
  waiting(): number | null;
  /** The service gave up on the request, or a member cancelled its wait: nothing may install by itself on its account any more. */
  cancel(): void;
  /** Called with the progress every time the backend hears of it. */
  onProgress(listener: (progress: UpdateProgress) => void): void;
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
  if (o.headless && isPackageEntry(o.entry, o.packageRoot)) return 'apt';
  if (o.desktopParent && o.parentPort) return 'desktop';
  return 'none';
}

/** Whether the entry script lies under the package root, so this server runs from the package. */
export function isPackageEntry(entry: string | undefined, packageRoot: string): boolean {
  return entry !== undefined && resolve(entry).startsWith(resolve(packageRoot) + sep);
}

/**
 * The version this server runs: `ORBITAL_VERSION` when set (the desktop app
 * sets it), else, for a server run from the package, the package's
 * `PACKAGE_VERSION_FILE`; null for anything else (a dev server).
 */
export function runningVersion(o: {
  env: { ORBITAL_VERSION?: string };
  entry: string | undefined;
  packageRoot: string;
  read?: (path: string) => string;
}): string | null {
  if (o.env.ORBITAL_VERSION) return o.env.ORBITAL_VERSION;
  if (!isPackageEntry(o.entry, o.packageRoot)) return null;
  try {
    const text = (o.read ?? ((path) => readFileSync(path, 'utf8')))(join(o.packageRoot, PACKAGE_VERSION_FILE)).trim();
    return isUpdateVersion(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * Writes a fresh request file: whatever is at the path is unlinked first
 * (`lstat`, so a symlink is removed, never followed), and the new file is
 * created exclusively without following a link. A request another writer
 * made between the two is a request all the same.
 */
export function writeRequest(path: string, content: string): void {
  try {
    lstatSync(path);
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw err;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

export class NoUpdateBackend implements UpdateBackend {
  readonly kind = 'none';
  readonly waitsItself = false;
  versions() {
    return { installed: null, candidate: null };
  }
  ready(): 'not_set_up' {
    return 'not_set_up';
  }
  waiting(): null {
    return null;
  }
  request(): 'not_set_up' {
    // Never reached: the service refuses `not_packaged` first.
    return 'not_set_up';
  }
  cancel(): void {}
  onProgress(): void {}
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
  readonly waitsItself = false;
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

  ready(): 'ok' | 'not_set_up' {
    return this.inDir(() => undefined);
  }

  request(): 'ok' | 'not_set_up' {
    return this.inDir((dir) => writeRequest(join(dir, UPDATE_REQUEST_FILE), `${Date.now()}\n`));
  }

  /** The service waits for the sessions (`waitsItself` false): nothing waits here. */
  waiting(): null {
    return null;
  }

  /** `act` in the request directory: `not_set_up` when setup has not made it, or not for this user. */
  private inDir(act: (dir: string) => void): 'ok' | 'not_set_up' {
    const dir = this.opts.requestDir ?? UPDATE_REQUEST_DIR;
    try {
      if (!statSync(dir).isDirectory()) return 'not_set_up';
      act(dir);
      return 'ok';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Setup has not run, or not for this user: the directory is missing or not ours to write.
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR') return 'not_set_up';
      throw err;
    }
  }

  /** The root updater, once it has the request, runs to its end; there is nothing to call back. */
  cancel(): void {}
  /** apt says nothing until the restart. */
  onProgress(): void {}

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
  /** Main waits after its download, with the words of the Mac being updated (canvas 50v 02). */
  readonly waitsItself = true;
  private latest: MainUpdateStateMessage | null = null;
  private progressListener: ((progress: UpdateProgress) => void) | null = null;
  private readonly listener = (event: { data: unknown }) => {
    const msg = parseMainMessage(event?.data);
    if (!msg) return;
    if (msg.t === 'update_ended') {
      this.progressListener?.({ ended: msg.reason });
      return;
    }
    this.latest = msg;
    this.progressListener?.(msg.downloaded ? 'downloaded' : msg.downloading ? 'downloading' : 'idle');
  };

  constructor(private readonly port: ParentPort) {
    port.on('message', this.listener);
  }

  versions() {
    return { installed: this.latest?.installed ?? null, candidate: this.latest?.available ?? null };
  }

  ready(): 'ok' {
    return 'ok';
  }

  request(by: UpdateAsker | null, when: UpdateWhen): 'ok' {
    const message: ServerUpdateMessage = { t: 'update_start', by: by && askerForMain(by), when };
    this.port.postMessage(message);
    return 'ok';
  }

  waiting(): number | null {
    return this.latest?.waiting ?? null;
  }

  cancel(): void {
    this.port.postMessage({ t: 'update_cancel' });
  }

  onProgress(listener: (progress: UpdateProgress) => void): void {
    this.progressListener = listener;
  }

  stop(): void {
    this.port.removeListener('message', this.listener);
  }
}

/**
 * The asker as main takes it (`ServerUpdateMessage`): main refuses a name
 * that is empty or too long, and with it the whole start, so it is cut here
 * and an empty one goes by the start of the id, as the roster names an
 * undescribed member.
 */
export function askerForMain(by: UpdateAsker): UpdateAsker {
  const id = by.id.slice(0, STARTED_BY_ID_MAX_CHARS);
  const name = (by.name.trim() === '' ? id.slice(0, 8) : by.name).slice(0, STARTED_BY_NAME_MAX_CHARS);
  return { id, name };
}
