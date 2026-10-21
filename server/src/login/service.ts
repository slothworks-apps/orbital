import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { ChatMessage } from '../types.js';
import { deliverOwnTurn, startedTurn, type DeliveryResult } from '../api/delivery.js';
import {
  LineSplitter,
  lastMeaningfulLine,
  loginEnv,
  manualUrlOf,
  readAuthStatus,
  readDesignEvent,
  readDesignStatus,
  type AccountStatus,
  type DesignStatus,
  type LoginKind,
} from './parse.js';

export type { LoginKind } from './parse.js';

/**
 * Logging a profile in from Orbital, server side (spec
 * 2026-10-21-log-in-from-orbital-design § 1, § 3): at most one run of
 * `claude auth login` or `claude design-login --json` per profile and kind,
 * the profile's status as the two status commands last answered it, and the
 * sessions waiting on a login, which continue once it is back.
 *
 * Everything the CLI writes is read by the pure functions of `parse.ts`;
 * this class only holds the processes and the state.
 */

/**
 * How long a `claude auth login` may run before it is cancelled. The CLI has
 * no time limit of its own: a login nobody answers waits for ever. Design's
 * own limit is the CLI's.
 */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** How long a cancelled design-login gets to exit on its own after its stdin closed, before it is killed. */
export const DESIGN_CANCEL_GRACE_MS = 3_000;

/** A status read that neither answers nor exits gives up after this long, and reads as unknown. */
export const STATUS_READ_TIMEOUT_MS = 15_000;

/**
 * How long a finished status read answers `GET` without another behind it.
 * A read is two `claude` processes, and every device that follows the
 * topic reads the state again on each event: without this a `GET` would
 * start a read, the read an event, and the event the next `GET`.
 */
export const STATUS_FRESH_MS = 30_000;

/** The most lines of a run's output kept for its failure message. */
const KEPT_LINES = 50;

/** Orbital's sentence for a login that was handed a code and failed (canvas 62e, 62h). */
export const WRONG_CODE_MESSAGE = 'That code is wrong or has expired. Open the sign-in page again for a new one.';
/** A cancelled login, whichever kind (canvas 62d). */
export const CANCELLED_MESSAGE = 'Cancelled. Nothing was changed.';
/** A `claude` login past `LOGIN_TIMEOUT_MS` — the CLI's own wording for design. */
export const TIMED_OUT_MESSAGE = 'The browser sign-in timed out. Try again.';
/** A failure the CLI said nothing about. */
const SILENT_FAILURE_MESSAGE = 'The login did not finish.';

// ---- Wire shapes (spec § 7) -----------------------------------------------

/** One login run, the running one or the last that ended, per profile and kind. */
export interface LoginRun {
  kind: LoginKind;
  claudeDirId: number;
  state: 'running' | 'succeeded' | 'failed';
  /** `browser` while the browser path can still finish it; `code` once only a code can; `checking` after a code was handed over. */
  step: 'browser' | 'code' | 'checking';
  /** Started from another device: BROWSER silenced, only the code finishes it. */
  manualOnly: boolean;
  /** Design only, local start only: the localhost-callback URL the web opens. */
  url: string | null;
  /** The page that shows a code. */
  manualUrl: string | null;
  manualFirst: boolean;
  /** null deviceId = this Mac. `name` is what the canvas shows ("Pixel 8"). */
  startedBy: { deviceId: string | null; name: string };
  /** failed: the sentence to show. */
  message: string | null;
  /** succeeded: the account now logged in. */
  account: string | null;
  /** Sessions on the profile's continuation list for this kind (§ 3). */
  waiting: { sessionId: string; title: string }[];
  startedAt: string;
  endedAt: string | null;
}

/** `GET /api/claude-dirs/:id/login`, and every event on `claude-dir-logins`. */
export interface ProfileLogin {
  claudeDirId: number;
  /** The profile's name ("Work"): another device knows no names of this Mac's profiles. */
  name: string | null;
  /** read: false until a status read answered; then the rest is its answer. */
  account: { read: boolean; loggedIn: boolean; email: string | null; orgName: string | null; plan: string | null };
  design: { read: boolean; available: boolean; signedIn: boolean };
  runs: { claude: LoginRun | null; design: LoginRun | null };
  /** false when no Claude executable is known: Log in is disabled. */
  cliAvailable: boolean;
}

/** `ApiSession.loginWait`: set while the session is on a continuation list. */
export interface LoginWait {
  kind: LoginKind;
  claudeDirId: number;
  /** The profile's login of that kind is running now: the map's hollow rest. */
  running: boolean;
  /** Who is running it, when another device is; null on this Mac or when nothing runs. */
  startedBy: string | null;
}

/** Who started a login. */
export type LoginStarter = LoginRun['startedBy'];

// ---- The process seam -------------------------------------------------------

/** A spawned login, as the service drives it. Injected so tests never run a real `claude`. */
export interface LoginChild {
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  /** Called once, when the process has exited and its output is read. */
  onExit(cb: (code: number | null) => void): void;
  write(text: string): void;
  closeStdin(): void;
  kill(): void;
}

export type LoginSpawn = (file: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => LoginChild;

/** One status command, run to its end; `stdout` whatever it wrote, whatever its exit code. */
export type StatusRun = (file: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => Promise<{ stdout: string }>;

/** How often the watchdog in `LOGIN_WATCHDOG` looks whether the server is still there. */
const LOGIN_WATCHDOG_INTERVAL_S = 2;

/**
 * The shell a login runs under. `auth login` never ends by itself (spec §
 * What the CLI does) and does not stop when its stdin closes, and the server
 * is stopped by a signal it does not handle (the desktop app quitting, a
 * restart), which runs no `dispose`: the CLI would outlive the server and
 * listen on its localhost port until the Mac restarts. Under this shell it
 * cannot. A watchdog ends the CLI as soon as the server (the shell's parent)
 * is gone; a TERM to the shell — a cancel or a timeout — ends the CLI with
 * it. `$0` is the CLI, the rest its arguments; the CLI's exit code is the
 * shell's.
 *
 * The CLI's stdin is the shell's own pipe, so a code and a design sign-in's
 * closing stdin still reach it. It goes through fd 3 on purpose: a POSIX sh
 * without job control gives a background command `/dev/null` for stdin
 * before its own redirections run, so in `dash` (`/bin/sh` on Debian and
 * Ubuntu) `"$0" <&0 &` reads nothing, while a saved copy survives.
 */
export const LOGIN_WATCHDOG = [
  'server=$PPID',
  'exec 3<&0',
  '"$0" "$@" <&3 3<&- &',
  'cli=$!',
  'exec 3<&-',
  "trap 'kill $cli 2>/dev/null; exit 143' TERM INT HUP",
  `( while kill -0 "$server" 2>/dev/null && kill -0 "$cli" 2>/dev/null; do sleep ${LOGIN_WATCHDOG_INTERVAL_S}; done; kill "$cli" 2>/dev/null ) </dev/null >/dev/null 2>&1 &`,
  'wait "$cli"',
].join('\n');

/** The real spawn: the CLI under `LOGIN_WATCHDOG`, stdin a pipe held open, output as text. */
export const spawnLogin: LoginSpawn = (file, args, opts) => {
  const child = spawn('/bin/sh', ['-c', LOGIN_WATCHDOG, file, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  // A write after the CLI exited is an EPIPE on stdin: nothing to tell anyone.
  child.stdin?.on('error', () => {});
  const exits: ((code: number | null) => void)[] = [];
  let exited = false;
  const exit = (code: number | null) => {
    if (exited) return;
    exited = true;
    for (const cb of exits) cb(code);
  };
  // `close` comes after the output streams ended; `error` alone when the spawn itself failed.
  child.on('close', (code) => exit(code));
  child.on('error', () => exit(null));
  return {
    onStdout: (cb) => child.stdout?.on('data', cb),
    onStderr: (cb) => child.stderr?.on('data', cb),
    onExit: (cb) => exits.push(cb),
    write: (text) => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(text);
    },
    closeStdin: () => child.stdin?.end(),
    kill: () => {
      child.kill('SIGTERM');
    },
  };
};

/** The real status read: `execFile`, bounded by `STATUS_READ_TIMEOUT_MS`. Exit 1 is an answer too. */
export const runStatus: StatusRun = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd: opts.cwd, env: opts.env, timeout: STATUS_READ_TIMEOUT_MS, encoding: 'utf8' }, (_err, stdout) => {
      resolve({ stdout: stdout ?? '' });
    });
  });

const LOGIN_ARGS: Record<LoginKind, string[]> = {
  claude: ['auth', 'login'],
  design: ['design-login', '--json'],
};
const STATUS_ARGS: Record<LoginKind, string[]> = {
  claude: ['auth', 'status', '--json'],
  design: ['design-login', '--json', '--status'],
};

// ---- The service ------------------------------------------------------------

export interface LoginServiceDeps {
  /** The executable logins run with — `mcpCliPath` in `index.ts`. Null: none, and the routes answer 503. */
  cliPath: string | null;
  /** The profile's path on disk, or undefined for an unknown id. */
  dirPath(claudeDirId: number): string | undefined;
  /** The profile's name, for `ProfileLogin.name`. */
  dirName?(claudeDirId: number): string | undefined;
  /** The e-mail in the profile's `.claude.json`, as the login was before a run (`readAccount`). */
  accountEmail?(claudeDirId: number): string | null;
  /** Every change of a profile's state; `index.ts` publishes it on `PROFILE_LOGINS_TOPIC`. */
  publish(login: ProfileLogin): void;
  /** A frame on a session's own topic: the `login_restored` notice and the turn sent. */
  publishToSession(sessionId: string, payload: Record<string, unknown>): void;
  /** Republishes one session's snapshot — `loginWait` rides on it. */
  republish(sessionId: string): void;
  /** What the sessions are, for continuing them. */
  sessions: {
    title(sessionId: string): string;
    /** Ended by hand, or gone: a login does not reopen it. */
    isEnded(sessionId: string): boolean;
    /** Waiting on a usage limit: left to the limit (spec § 3 Continuing). */
    isLimitWaiting(sessionId: string): boolean;
  };
  /** The limits' "Message sent on continue" (`continueTextOf(CONTINUE_TEXT_KEY)`). */
  continueText(): string;
  /**
   * The limits' "Continue automatically after a limit reset"
   * (`autoContinueOf(AUTO_CONTINUE_KEY)`): off, a login says so in the
   * transcript and sends nothing (spec § Scope).
   */
  autoContinue(): boolean;
  onError?(err: unknown, during: string, sessionId?: string): void;
  /** The server's own environment; `process.env` when absent. */
  baseEnv?: NodeJS.ProcessEnv;
  home?: string;
  spawn?: LoginSpawn;
  runStatus?: StatusRun;
  now?: () => number;
}

/** What a run holds beyond its wire shape. */
interface Run {
  wire: Omit<LoginRun, 'waiting'>;
  child: LoginChild | null;
  /** Its output, stdout and stderr together, newest last. */
  lines: string[];
  codeGiven: boolean;
  /** How it was ended by Orbital, if it was; the exit then only reads the status again. */
  endedBy: 'cancel' | 'timeout' | null;
  /** Design: the `done` event's message. */
  doneMessage: string | null;
  /** The account before the run, for `login_restored`'s `previousEmail`. */
  previousEmail: string | null;
  /** Logged in (or signed in, for design) by the last status read before the run. */
  wasLoggedIn: boolean;
  /** Its process has not exited yet — a cancelled design-login may still be within `DESIGN_CANCEL_GRACE_MS`. */
  alive: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
}

/** One profile's status as last read, and its runs. */
interface Profile {
  account: ProfileLogin['account'];
  design: ProfileLogin['design'];
  reading: Promise<void> | null;
  /** When the last status read finished; null before the first. */
  readAt: number | null;
  runs: { claude: Run | null; design: Run | null };
}

/** Why a call was refused; the routes turn it into a status. */
export type LoginRefusal = 'not_found' | 'no_cli' | 'no_login';

export type LoginAnswer = { ok: true; login: ProfileLogin } | { ok: false; error: LoginRefusal };

/** Info a main turn's end carries for the continuation lists (`Runner` `onTurnEnd`). */
export interface TurnEndInfo {
  /** The turn ended on `authentication_failed`. */
  loginLost: boolean;
  /** The turn contained a DesignSync failure naming `/design-login`. */
  designLoginLost: boolean;
}

export class LoginService {
  /**
   * The one path into a session (send if live, revive if not), assigned by
   * the routes, which own it — as `LimitsService.deliver` is.
   */
  deliver?: (sessionId: string, text: string) => Promise<DeliveryResult>;

  private deps: LoginServiceDeps;
  private now: () => number;
  private profiles = new Map<number, Profile>();
  /**
   * The continuation lists (spec § 3 Continuing): the sessions whose latest
   * main turn ended on a lost login, per profile and kind, in memory only —
   * a restart empties them, and the user continues by writing.
   */
  private waiting = new Map<string, { claudeDirId: number; kind: LoginKind }[]>();
  private seq = 0;
  private disposed = false;

  constructor(deps: LoginServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  get cliAvailable(): boolean {
    return this.deps.cliPath !== null;
  }

  /** Whether the profile is configured. */
  has(claudeDirId: number): boolean {
    return Number.isInteger(claudeDirId) && this.deps.dirPath(claudeDirId) !== undefined;
  }

  // ---- State ----------------------------------------------------------------

  /**
   * The profile's state for `GET`: read first when no status was ever read,
   * at once otherwise. A read goes on behind it, its answer on the topic,
   * only when the last one finished more than `STATUS_FRESH_MS` ago. Null
   * for an unknown profile.
   */
  async state(claudeDirId: number): Promise<ProfileLogin | null> {
    if (!this.has(claudeDirId)) return null;
    const p = this.profile(claudeDirId);
    if (this.cliAvailable && (p.readAt === null || this.now() - p.readAt >= STATUS_FRESH_MS)) {
      const read = this.readStatus(claudeDirId);
      if (!p.account.read && !p.design.read) await read;
    }
    return this.snapshot(claudeDirId);
  }

  snapshot(claudeDirId: number): ProfileLogin {
    const p = this.profile(claudeDirId);
    return {
      claudeDirId,
      name: this.deps.dirName?.(claudeDirId) ?? null,
      account: { ...p.account },
      design: { ...p.design },
      runs: { claude: this.runWire(claudeDirId, p.runs.claude), design: this.runWire(claudeDirId, p.runs.design) },
      cliAvailable: this.cliAvailable,
    };
  }

  /**
   * Both status commands again; concurrent callers share one read. A read
   * that fails or answers a shape Orbital does not know is unknown
   * (`read: false`), never logged out. `fresh` waits out a read already in
   * flight and reads again: one that started before a login ended cannot
   * tell how it ended. The answer goes out on the topic only when it
   * differs from the one before; a run that ended publishes its own end.
   */
  readStatus(claudeDirId: number, fresh = false): Promise<void> {
    const p = this.profile(claudeDirId);
    if (p.reading) return fresh ? p.reading.then(() => this.readStatus(claudeDirId, true)) : p.reading;
    const cliPath = this.deps.cliPath;
    const dirPath = this.deps.dirPath(claudeDirId);
    if (cliPath === null || dirPath === undefined) return Promise.resolve();
    const run = this.deps.runStatus ?? runStatus;
    const opts = { cwd: this.home(), env: loginEnv(this.baseEnv(), dirPath, { remote: false, home: this.deps.home }) };
    const readOne = async (kind: LoginKind): Promise<string | null> => {
      try {
        return (await run(cliPath, STATUS_ARGS[kind], opts)).stdout;
      } catch (err) {
        this.deps.onError?.(err, `reading the ${kind === 'claude' ? 'login' : 'Claude Design'} status`);
        return null;
      }
    };
    p.reading = Promise.all([readOne('claude'), readOne('design')])
      .then(([auth, design]) => {
        const account = accountOf(auth === null ? null : readAuthStatus(auth));
        const designState = designOf(design === null ? null : readDesignStatus(design));
        const differs = !sameFields(account, p.account) || !sameFields(designState, p.design);
        p.account = account;
        p.design = designState;
        if (differs) this.changed(claudeDirId);
      })
      .finally(() => {
        p.reading = null;
        p.readAt = this.now();
      });
    return p.reading;
  }

  // ---- Runs -----------------------------------------------------------------

  /**
   * Starts a login of this kind, or answers the one running. `manualOnly`
   * silences `BROWSER`, so only the pasted code finishes it: always for
   * another device, and for a session's orbital MCP tools, which nobody at
   * this Mac asked to open a browser.
   */
  start(
    claudeDirId: number, kind: LoginKind, startedBy: LoginStarter, manualOnly = startedBy.deviceId !== null,
  ): LoginAnswer {
    const dirPath = this.has(claudeDirId) ? this.deps.dirPath(claudeDirId) : undefined;
    if (dirPath === undefined) return { ok: false, error: 'not_found' };
    const cliPath = this.deps.cliPath;
    if (cliPath === null) return { ok: false, error: 'no_cli' };
    const p = this.profile(claudeDirId);
    const previous = p.runs[kind];
    if (previous?.wire.state === 'running') return { ok: true, login: this.snapshot(claudeDirId) };
    // A cancelled design-login still within its grace may hold the CLI's
    // localhost port: it goes before a second one starts.
    if (previous?.alive) {
      this.clearTimers(previous);
      previous.child?.kill();
    }

    const remote = manualOnly;
    const run: Run = {
      wire: {
        kind, claudeDirId, state: 'running',
        // Only the code can finish a login whose browser path is silenced.
        step: remote ? 'code' : 'browser',
        manualOnly: remote, url: null, manualUrl: null, manualFirst: false,
        startedBy: { ...startedBy }, message: null, account: null,
        startedAt: new Date(this.now()).toISOString(), endedAt: null,
      },
      child: null, lines: [], codeGiven: false, endedBy: null, doneMessage: null,
      previousEmail: p.account.read ? p.account.email : (this.deps.accountEmail?.(claudeDirId) ?? null),
      wasLoggedIn: loggedInOf(p, kind),
      alive: false,
      timer: null, killTimer: null,
    };
    p.runs[kind] = run;
    try {
      const child = (this.deps.spawn ?? spawnLogin)(cliPath, LOGIN_ARGS[kind], {
        cwd: this.home(),
        env: loginEnv(this.baseEnv(), dirPath, { remote, home: this.deps.home }),
      });
      run.child = child;
      run.alive = true;
      this.follow(claudeDirId, run, child);
    } catch (err) {
      this.deps.onError?.(err, 'starting a login');
      this.end(claudeDirId, run, 'failed', err instanceof Error ? err.message : SILENT_FAILURE_MESSAGE);
      return { ok: true, login: this.snapshot(claudeDirId) };
    }
    if (kind === 'claude') {
      run.timer = setTimeout(() => this.stop(claudeDirId, run, 'timeout'), LOGIN_TIMEOUT_MS);
      (run.timer as unknown as { unref?: () => void }).unref?.();
    }
    this.changed(claudeDirId);
    // The sessions waiting on it rest while it runs (spec § 3): their
    // `loginWait.running` rides on their own snapshots.
    for (const sessionId of this.waitingOn(claudeDirId, kind)) this.deps.republish(sessionId);
    return { ok: true, login: this.snapshot(claudeDirId) };
  }

  /** Hands the pasted code (already `cleanLoginCode`d) to the running login. */
  code(claudeDirId: number, kind: LoginKind, code: string): LoginAnswer {
    if (!this.has(claudeDirId)) return { ok: false, error: 'not_found' };
    const run = this.profile(claudeDirId).runs[kind];
    if (!run || run.wire.state !== 'running' || !run.child) return { ok: false, error: 'no_login' };
    run.child.write(kind === 'design' ? `${JSON.stringify({ code })}\n` : `${code}\n`);
    run.codeGiven = true;
    run.wire.step = 'checking';
    this.changed(claudeDirId);
    return { ok: true, login: this.snapshot(claudeDirId) };
  }

  /** Cancels the running login: it fails at once with `CANCELLED_MESSAGE`. */
  cancel(claudeDirId: number, kind: LoginKind): LoginAnswer {
    if (!this.has(claudeDirId)) return { ok: false, error: 'not_found' };
    const run = this.profile(claudeDirId).runs[kind];
    if (!run || run.wire.state !== 'running') return { ok: false, error: 'no_login' };
    this.stop(claudeDirId, run, 'cancel');
    return { ok: true, login: this.snapshot(claudeDirId) };
  }

  /**
   * Every login whose process is still there is killed — a running one, and
   * a cancelled design-login within its grace: the server is stopping.
   */
  dispose(): void {
    this.disposed = true;
    for (const p of this.profiles.values()) {
      for (const run of [p.runs.claude, p.runs.design]) {
        if (!run) continue;
        this.clearTimers(run);
        if (run.alive) run.child?.kill();
      }
    }
  }

  /**
   * The profile was removed: its logins stop, its state goes, and no
   * session waits on it any more.
   */
  forgetDir(claudeDirId: number): void {
    const p = this.profiles.get(claudeDirId);
    if (p) {
      for (const run of [p.runs.claude, p.runs.design]) {
        if (!run) continue;
        this.clearTimers(run);
        run.endedBy = 'cancel';
        if (run.alive) run.child?.kill();
      }
      this.profiles.delete(claudeDirId);
    }
    for (const [sessionId, lists] of [...this.waiting]) {
      const rest = lists.filter((l) => l.claudeDirId !== claudeDirId);
      if (rest.length === lists.length) continue;
      if (rest.length === 0) this.waiting.delete(sessionId);
      else this.waiting.set(sessionId, rest);
      this.deps.republish(sessionId);
    }
  }

  private follow(claudeDirId: number, run: Run, child: LoginChild): void {
    const out = new LineSplitter();
    const err = new LineSplitter();
    child.onStdout((chunk) => {
      for (const line of out.push(chunk)) this.onLine(claudeDirId, run, line);
    });
    child.onStderr((chunk) => {
      for (const line of err.push(chunk)) this.keep(run, line);
    });
    child.onExit((code) => {
      run.alive = false;
      for (const line of out.flush()) this.onLine(claudeDirId, run, line);
      for (const line of err.flush()) this.keep(run, line);
      this.exited(claudeDirId, run, code).catch((e: unknown) => this.deps.onError?.(e, 'ending a login'));
    });
  }

  private onLine(claudeDirId: number, run: Run, line: string): void {
    this.keep(run, line);
    if (run.wire.state !== 'running') return;
    if (run.wire.kind === 'claude') {
      const manualUrl = manualUrlOf(line);
      if (manualUrl && manualUrl !== run.wire.manualUrl) {
        run.wire.manualUrl = manualUrl;
        this.changed(claudeDirId);
      }
      return;
    }
    const event = readDesignEvent(line);
    if (!event) return;
    if (event.event === 'pages') {
      run.wire.manualUrl = event.manualUrl;
      run.wire.manualFirst = event.manualFirst;
      // The localhost callback is useless to a device that is not this Mac.
      run.wire.url = run.wire.manualOnly ? null : event.url;
      // With the manual page first, or no callback to open, only the code finishes it.
      if (run.wire.step === 'browser' && (event.manualFirst || event.url === null)) run.wire.step = 'code';
      this.changed(claudeDirId);
    } else {
      run.doneMessage = event.message;
      // `done` is the CLI's last word; its stdin may close now.
      run.child?.closeStdin();
    }
  }

  private keep(run: Run, line: string): void {
    run.lines.push(line);
    if (run.lines.length > KEPT_LINES) run.lines.splice(0, run.lines.length - KEPT_LINES);
  }

  /** Orbital ends a running login: cancelled or out of time. */
  private stop(claudeDirId: number, run: Run, why: 'cancel' | 'timeout'): void {
    if (run.wire.state !== 'running') return;
    run.endedBy = why;
    const child = run.child;
    if (run.wire.kind === 'design' && child) {
      // Closing stdin is the CLI's own cancel; the kill is for one that does not hear it.
      child.closeStdin();
      run.killTimer = setTimeout(() => child.kill(), DESIGN_CANCEL_GRACE_MS);
      (run.killTimer as unknown as { unref?: () => void }).unref?.();
    } else {
      child?.kill();
    }
    this.end(claudeDirId, run, 'failed', why === 'cancel' ? CANCELLED_MESSAGE : TIMED_OUT_MESSAGE);
  }

  /**
   * The process is gone. Success is read, not parsed: the status is read
   * again, and logged in (or signed in) is `succeeded` whatever the CLI
   * printed.
   *
   * A run Orbital stopped (cancel, time limit) has already failed, but the
   * CLI may have finished the login just before it was stopped. When the
   * status now reads logged in and it did not before the run — or, for the
   * profile's own login, as another account — the login did happen: the run
   * is `succeeded` after all and the sessions waiting on it continue, rather
   * than saying "Nothing was changed" over a login that changed it.
   */
  private async exited(claudeDirId: number, run: Run, _code: number | null): Promise<void> {
    this.clearTimers(run);
    if (this.disposed) return;
    const p = this.profiles.get(claudeDirId);
    if (!p || p.runs[run.wire.kind] !== run) return;
    await this.readStatus(claudeDirId, true);
    // The server may have stopped, or the profile gone or started again, while the status was read.
    if (this.disposed || this.profiles.get(claudeDirId) !== p || p.runs[run.wire.kind] !== run) return;
    const kind = run.wire.kind;
    const loggedIn = loggedInOf(p, kind);
    if (run.endedBy !== null) {
      const changedAccount = kind === 'claude' && p.account.email !== run.previousEmail;
      if (run.wire.state !== 'failed' || !loggedIn || (run.wasLoggedIn && !changedAccount)) return;
    } else if (run.wire.state !== 'running') {
      return;
    }
    if (loggedIn) {
      const email = kind === 'claude' ? p.account.email : (p.account.email ?? this.deps.accountEmail?.(claudeDirId) ?? null);
      run.wire.account = email;
      this.end(claudeDirId, run, 'succeeded', null);
      await this.continueSessions(claudeDirId, kind, email, kind === 'claude' ? run.previousEmail : null);
      return;
    }
    this.end(claudeDirId, run, 'failed', this.failureOf(run));
  }

  /** The sentence a failed run shows (spec § 1). */
  private failureOf(run: Run): string {
    if (run.codeGiven) return WRONG_CODE_MESSAGE;
    if (run.wire.kind === 'design' && run.doneMessage) return run.doneMessage;
    if (run.wire.kind === 'design') {
      // Design speaks JSON; a line that is not one of its events is the CLI's own words.
      const words = run.lines.filter((l) => readDesignEvent(l) === null && !/^\s*\{/.test(l));
      return lastMeaningfulLine(words) ?? SILENT_FAILURE_MESSAGE;
    }
    return lastMeaningfulLine(run.lines) ?? SILENT_FAILURE_MESSAGE;
  }

  private end(claudeDirId: number, run: Run, state: 'succeeded' | 'failed', message: string | null): void {
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    run.wire.state = state;
    run.wire.message = message;
    run.wire.endedAt = new Date(this.now()).toISOString();
    this.changed(claudeDirId);
    // While it ran, the sessions waiting on it rested; now they do not.
    for (const sessionId of this.waitingOn(claudeDirId, run.wire.kind)) this.deps.republish(sessionId);
  }

  private clearTimers(run: Run): void {
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    // The kill timer stays armed past `exit` only when the process is still there.
    if (run.killTimer) clearTimeout(run.killTimer);
    run.killTimer = null;
  }

  // ---- Continuation lists -------------------------------------------------------

  /**
   * A main turn of an Orbital session ended. Its latest turn decides: on a
   * lost login it goes on the list of its profile and kind, otherwise off
   * every list.
   */
  turnEnded(sessionId: string, claudeDirId: number, info: TurnEndInfo): void {
    const want: { claudeDirId: number; kind: LoginKind }[] = [];
    if (info.loginLost) want.push({ claudeDirId, kind: 'claude' });
    if (info.designLoginLost) want.push({ claudeDirId, kind: 'design' });
    const had = this.waiting.get(sessionId) ?? [];
    if (want.length === 0) this.waiting.delete(sessionId);
    else this.waiting.set(sessionId, want);
    if (!sameLists(had, want)) this.listsChanged(sessionId, [...had, ...want]);
  }

  /**
   * A new turn began, the user's or any other, or the session was ended:
   * it waits on no login any more.
   */
  forget(sessionId: string): void {
    const had = this.waiting.get(sessionId);
    if (!had) return;
    this.waiting.delete(sessionId);
    this.listsChanged(sessionId, had);
  }

  waitFor(sessionId: string): LoginWait | null {
    const lists = this.waiting.get(sessionId);
    if (!lists || lists.length === 0) return null;
    // The profile's own login before Claude Design's: without it nothing runs.
    const { claudeDirId, kind } = lists.find((l) => l.kind === 'claude') ?? lists[0];
    const run = this.profiles.get(claudeDirId)?.runs[kind];
    const running = run?.wire.state === 'running';
    return {
      kind, claudeDirId, running,
      startedBy: running && run.wire.startedBy.deviceId !== null ? run.wire.startedBy.name : null,
    };
  }

  private waitingOn(claudeDirId: number, kind: LoginKind): string[] {
    const ids: string[] = [];
    for (const [sessionId, lists] of this.waiting) {
      if (lists.some((l) => l.claudeDirId === claudeDirId && l.kind === kind)) ids.push(sessionId);
    }
    return ids;
  }

  private listsChanged(sessionId: string, touched: { claudeDirId: number }[]): void {
    this.deps.republish(sessionId);
    for (const dir of new Set(touched.map((t) => t.claudeDirId))) {
      if (this.profiles.has(dir)) this.changed(dir);
    }
  }

  /**
   * A login of this profile and kind succeeded: every session on its list
   * that has not ended, and is not left to a usage limit, gets the
   * continuation text through the one delivery path, a `login_restored`
   * notice, and the sent turn published — as a limit wait firing does
   * (`LimitsService.fire`).
   */
  private async continueSessions(
    claudeDirId: number, kind: LoginKind, email: string | null, previousEmail: string | null,
  ): Promise<void> {
    const ids = this.waitingOn(claudeDirId, kind);
    for (const sessionId of ids) {
      const rest = (this.waiting.get(sessionId) ?? []).filter((l) => !(l.claudeDirId === claudeDirId && l.kind === kind));
      if (rest.length === 0) this.waiting.delete(sessionId);
      else this.waiting.set(sessionId, rest);
    }
    if (ids.length > 0) this.changed(claudeDirId);
    const text = this.deps.continueText();
    for (const sessionId of ids) {
      const seq = ++this.seq;
      // The notice comes after the delivery, so "· continued" is said only of a turn that started.
      let continued = false;
      try {
        if (this.deps.sessions.isEnded(sessionId) || this.deps.sessions.isLimitWaiting(sessionId) || !this.deliver) {
          this.deps.republish(sessionId);
          continue;
        }
        // With the limits' switch off, the login says so and sends nothing (spec § Scope).
        if (this.deps.autoContinue()) {
          const delivery = await deliverOwnTurn(
            this.deliver,
            (id, payload) => this.deps.publishToSession(id, payload),
            { sessionId, text, id: `${sessionId}:login-sent:${seq}` },
            this.now,
          );
          continued = startedTurn(delivery.outcome);
        }
      } catch (err) {
        this.deps.onError?.(err, 'continuing after a login', sessionId);
      }
      try {
        const notice: ChatMessage = {
          id: `${sessionId}:login-restored:${seq}`,
          role: 'notice',
          timestamp: new Date(this.now()).toISOString(),
          text: restoredText(kind, email, continued),
          notice: { level: 'info', kind: 'login_restored', login: { kind, email, previousEmail, continued } },
        };
        this.deps.publishToSession(sessionId, { event: 'message', message: notice });
      } catch (err) {
        this.deps.onError?.(err, 'continuing after a login', sessionId);
      }
      this.deps.republish(sessionId);
    }
  }

  // ---- Internals ----------------------------------------------------------------

  private profile(claudeDirId: number): Profile {
    let p = this.profiles.get(claudeDirId);
    if (!p) {
      p = { account: accountOf(null), design: designOf(null), reading: null, readAt: null, runs: { claude: null, design: null } };
      this.profiles.set(claudeDirId, p);
    }
    return p;
  }

  private runWire(claudeDirId: number, run: Run | null): LoginRun | null {
    if (!run) return null;
    const waiting = this.waitingOn(claudeDirId, run.wire.kind)
      .map((sessionId) => ({ sessionId, title: this.deps.sessions.title(sessionId) }));
    return { ...run.wire, startedBy: { ...run.wire.startedBy }, waiting };
  }

  /** The state goes out; a state that cannot be made is recorded, never thrown at the change that asked. */
  private changed(claudeDirId: number): void {
    if (this.disposed || this.deps.dirPath(claudeDirId) === undefined) return;
    try {
      this.deps.publish(this.snapshot(claudeDirId));
    } catch (err) {
      this.deps.onError?.(err, 'publishing a login state');
    }
  }

  private baseEnv(): NodeJS.ProcessEnv {
    return this.deps.baseEnv ?? process.env;
  }

  private home(): string {
    return this.deps.home ?? homedir();
  }
}

function accountOf(status: AccountStatus | null): ProfileLogin['account'] {
  return status
    ? { read: true, ...status }
    : { read: false, loggedIn: false, email: null, orgName: null, plan: null };
}

function designOf(status: DesignStatus | null): ProfileLogin['design'] {
  return status ? { read: true, ...status } : { read: false, available: false, signedIn: false };
}

/** Logged in (or, for design, signed in) by the last status read; unknown is not. */
function loggedInOf(p: Profile, kind: LoginKind): boolean {
  return kind === 'claude' ? p.account.read && p.account.loggedIn : p.design.read && p.design.signedIn;
}

/** Two status answers alike field by field. */
function sameFields<T extends object>(a: T, b: T): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof T>;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function sameLists(a: { claudeDirId: number; kind: LoginKind }[], b: { claudeDirId: number; kind: LoginKind }[]): boolean {
  return a.length === b.length && a.every((x) => b.some((y) => y.claudeDirId === x.claudeDirId && y.kind === x.kind));
}

/**
 * The line of the `login_restored` notice (canvas 62a: "Logged in as
 * <e-mail> · continued"); without "· continued" when nothing was sent.
 */
function restoredText(kind: LoginKind, email: string | null, continued: boolean): string {
  const said = kind === 'design' ? 'Signed in to Claude Design' : email ? `Logged in as ${email}` : 'Logged in';
  return continued ? `${said} · continued` : said;
}
