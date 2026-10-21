import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { ChatMessage } from '../types.js';
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

/** The hub topic every change of a profile's login state goes out on (spec § 2). */
export const CLAUDE_DIR_LOGINS_TOPIC = 'claude-dir-logins';

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

/** The real spawn: no shell, stdin a pipe held open, output as text. */
export const spawnLogin: LoginSpawn = (file, args, opts) => {
  const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
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

/** What a delivery into a session did — the routes' `deliverToSession`. */
export type LoginDeliveryOutcome = 'sent' | 'revived' | 'not_found' | 'terminal';

export interface LoginServiceDeps {
  /** The executable logins run with — `mcpCliPath` in `index.ts`. Null: none, and the routes answer 503. */
  cliPath: string | null;
  /** The profile's path on disk, or undefined for an unknown id. */
  dirPath(claudeDirId: number): string | undefined;
  /** The e-mail in the profile's `.claude.json`, as the login was before a run (`readAccount`). */
  accountEmail?(claudeDirId: number): string | null;
  /** Every change of a profile's state; `index.ts` publishes it on `CLAUDE_DIR_LOGINS_TOPIC`. */
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
  timer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
}

/** One profile's status as last read, and its runs. */
interface Profile {
  account: ProfileLogin['account'];
  design: ProfileLogin['design'];
  reading: Promise<void> | null;
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
  deliver?: (sessionId: string, text: string) => Promise<{ outcome: LoginDeliveryOutcome; uuid: string | null }>;

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
   * at once otherwise, with a read behind it whose answer goes out on the
   * topic. Null for an unknown profile.
   */
  async state(claudeDirId: number): Promise<ProfileLogin | null> {
    if (!this.has(claudeDirId)) return null;
    const p = this.profile(claudeDirId);
    if (this.cliAvailable) {
      const read = this.readStatus(claudeDirId);
      if (!p.account.read && !p.design.read) await read;
    }
    return this.snapshot(claudeDirId);
  }

  snapshot(claudeDirId: number): ProfileLogin {
    const p = this.profile(claudeDirId);
    return {
      claudeDirId,
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
   * tell how it ended.
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
        p.account = accountOf(auth === null ? null : readAuthStatus(auth));
        p.design = designOf(design === null ? null : readDesignStatus(design));
      })
      .finally(() => {
        p.reading = null;
        this.changed(claudeDirId);
      });
    return p.reading;
  }

  // ---- Runs -----------------------------------------------------------------

  /** Starts a login of this kind, or answers the one running. */
  start(claudeDirId: number, kind: LoginKind, startedBy: LoginStarter): LoginAnswer {
    const dirPath = this.has(claudeDirId) ? this.deps.dirPath(claudeDirId) : undefined;
    if (dirPath === undefined) return { ok: false, error: 'not_found' };
    const cliPath = this.deps.cliPath;
    if (cliPath === null) return { ok: false, error: 'no_cli' };
    const p = this.profile(claudeDirId);
    if (p.runs[kind]?.wire.state === 'running') return { ok: true, login: this.snapshot(claudeDirId) };

    const remote = startedBy.deviceId !== null;
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
      timer: null, killTimer: null,
    };
    p.runs[kind] = run;
    try {
      const child = (this.deps.spawn ?? spawnLogin)(cliPath, LOGIN_ARGS[kind], {
        cwd: this.home(),
        env: loginEnv(this.baseEnv(), dirPath, { remote, home: this.deps.home }),
      });
      run.child = child;
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

  /** Every running login is killed: the server is stopping. */
  dispose(): void {
    this.disposed = true;
    for (const p of this.profiles.values()) {
      for (const run of [p.runs.claude, p.runs.design]) {
        if (!run) continue;
        this.clearTimers(run);
        if (run.wire.state === 'running') run.child?.kill();
      }
    }
  }

  /** The profile was removed: its logins stop and its state goes. */
  forgetDir(claudeDirId: number): void {
    const p = this.profiles.get(claudeDirId);
    if (!p) return;
    for (const run of [p.runs.claude, p.runs.design]) {
      if (!run) continue;
      this.clearTimers(run);
      run.endedBy = 'cancel';
      if (run.wire.state === 'running') run.child?.kill();
    }
    this.profiles.delete(claudeDirId);
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
      for (const line of out.flush()) this.onLine(claudeDirId, run, line);
      for (const line of err.flush()) this.keep(run, line);
      void this.exited(claudeDirId, run, code);
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
   */
  private async exited(claudeDirId: number, run: Run, _code: number | null): Promise<void> {
    this.clearTimers(run);
    if (this.disposed) return;
    const p = this.profiles.get(claudeDirId);
    if (!p || p.runs[run.wire.kind] !== run) return;
    await this.readStatus(claudeDirId, true);
    if (run.wire.state !== 'running' || run.endedBy !== null) return;
    const kind = run.wire.kind;
    const loggedIn = kind === 'claude' ? p.account.read && p.account.loggedIn : p.design.read && p.design.signedIn;
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
      try {
        if (this.deps.sessions.isEnded(sessionId) || this.deps.sessions.isLimitWaiting(sessionId) || !this.deliver) {
          this.deps.republish(sessionId);
          continue;
        }
        const seq = ++this.seq;
        const notice: ChatMessage = {
          id: `${sessionId}:login-restored:${seq}`,
          role: 'notice',
          timestamp: new Date(this.now()).toISOString(),
          text: restoredText(kind, email),
          notice: { level: 'info', kind: 'login_restored', login: { kind, email, previousEmail, continued: true } },
        };
        this.deps.publishToSession(sessionId, { event: 'message', message: notice });
        const delivery = await this.deliver(sessionId, text);
        // Orbital's own sends are not replayed by the SDK, and nobody typed this one.
        if (delivery.outcome === 'sent' || delivery.outcome === 'revived') {
          const turn: ChatMessage = {
            id: `${sessionId}:login-sent:${seq}`,
            role: 'user',
            text,
            timestamp: new Date(this.now()).toISOString(),
            ...(delivery.uuid ? { uuid: delivery.uuid } : {}),
          };
          this.deps.publishToSession(sessionId, { event: 'message', message: turn });
        }
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
      p = { account: accountOf(null), design: designOf(null), reading: null, runs: { claude: null, design: null } };
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

function sameLists(a: { claudeDirId: number; kind: LoginKind }[], b: { claudeDirId: number; kind: LoginKind }[]): boolean {
  return a.length === b.length && a.every((x) => b.some((y) => y.claudeDirId === x.claudeDirId && y.kind === x.kind));
}

/** The line of the `login_restored` notice (canvas 62a: "Logged in as <e-mail> · continued"). */
function restoredText(kind: LoginKind, email: string | null): string {
  if (kind === 'design') return 'Signed in to Claude Design · continued';
  return email ? `Logged in as ${email} · continued` : 'Logged in · continued';
}
