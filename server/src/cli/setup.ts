/**
 * `orbital setup`: the once-per-machine step after `apt install orbital`
 * (spec 2026-10-19-headless-server-design → How it is used, One user per
 * machine). Run as the user Orbital runs as; the root steps go through
 * `sudo`, each shown before it runs. Running it again changes nothing that
 * is already right, and says so.
 */
import { execFile, spawn } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { UPDATE_REQUEST_DIR } from '../update/backends.js';
import type { Io } from './io.js';
import { SERVICE_USER_FILE, USER_NAME } from './target.js';

/** The user unit the package installs. */
export const USER_UNIT_FILE = '/usr/lib/systemd/user/orbital.service';
/** Where logind records a user whose manager runs without a login. */
export const LINGER_DIR = '/var/lib/systemd/linger';
/** How long a first start may take (migrations, the login shell's PATH) before setup gives up waiting. */
export const SETUP_START_TIMEOUT_MS = 60_000;
/** How long the user's systemd manager, which lingering starts, may take to answer. */
export const USER_MANAGER_WAIT_MS = 15_000;
const POLL_MS = 500;
/** The request directory's mode: the user writes requests, root reads the directory. */
const REQUEST_DIR_MODE = 0o770;

/** What setup finds before it changes anything. */
export type SetupFacts = {
  platform: NodeJS.Platform;
  uid: number;
  user: string;
  gid: number;
  /** `/etc/orbital/user` as written, trimmed; null without the file. */
  recordedUser: string | null;
  unitInstalled: boolean;
  requestDir: { uid: number; gid: number; mode: number; isDirectory: boolean } | null;
  pathUnit: { enabled: boolean; active: boolean };
  linger: boolean;
};

/** One root step: what it is for, and the command `sudo` runs (with its stdin, if any). */
export type RootStep = { why: string; argv: string[]; input?: string };

/**
 * The root steps still needed, or why setup cannot run here. Pure: the
 * facts are gathered by `SetupSys.facts`.
 */
export function setupPlan(f: SetupFacts): { error: string } | { steps: RootStep[] } {
  if (f.platform !== 'linux') {
    return { error: 'orbital setup is for a Linux server running the orbital package. On a Mac, the Orbital app runs the server.' };
  }
  if (f.uid === 0) {
    return { error: 'Run orbital setup as the user Orbital should run as, not as root. It asks for sudo itself.' };
  }
  if (!f.unitInstalled) {
    return { error: `The orbital package is not installed here (no ${USER_UNIT_FILE}). Install it first: sudo apt install orbital` };
  }
  if (!USER_NAME.test(f.user)) {
    return { error: `Your user name, ${f.user}, is not one systemd and apt take for a user.` };
  }
  if (f.recordedUser !== null && f.recordedUser !== '' && f.recordedUser !== f.user) {
    const who = USER_NAME.test(f.recordedUser) ? f.recordedUser : 'another user';
    return {
      error: `Orbital on this machine is set up for ${who}. A machine runs Orbital for one user: run orbital as ${who}.`,
    };
  }
  const steps: RootStep[] = [];
  if (f.recordedUser !== f.user) {
    steps.push(
      { why: 'make /etc/orbital', argv: ['install', '-d', '-m', '0755', '/etc/orbital'] },
      { why: `record ${f.user} as the user Orbital runs as`, argv: ['tee', SERVICE_USER_FILE], input: `${f.user}\n` },
    );
  }
  const dir = f.requestDir;
  if (!dir || !dir.isDirectory || dir.uid !== 0 || dir.gid !== f.gid || (dir.mode & 0o7777) !== REQUEST_DIR_MODE) {
    steps.push({
      why: 'make the directory the server writes update requests to',
      argv: ['install', '-d', '-o', 'root', '-g', String(f.gid), '-m', REQUEST_DIR_MODE.toString(8).padStart(4, '0'), UPDATE_REQUEST_DIR],
    });
  }
  if (!f.pathUnit.enabled || !f.pathUnit.active) {
    steps.push({ why: 'turn on the updater, which can only upgrade orbital', argv: ['systemctl', 'enable', '--now', 'orbital-update.path'] });
  }
  if (!f.linger) {
    steps.push({ why: 'keep your services running without a login', argv: ['loginctl', 'enable-linger', f.user] });
  }
  return { steps };
}

/** What a command answered. */
export type RunResult = { code: number; stdout: string; stderr: string };

/** The machine as setup sees it; injected so the flow runs in tests. */
export interface SetupSys {
  facts(): Promise<SetupFacts>;
  /** A command as this user, its output captured. */
  run(argv: string[]): Promise<RunResult>;
  /** A command under `sudo`, on this terminal (so sudo can ask for the password). */
  sudo(step: RootStep): Promise<number>;
  /** Whether Orbital answers its health route on the port. */
  healthy(port: number): Promise<boolean>;
}

export type SetupDeps = {
  io: Io;
  sys: SetupSys;
  port: number;
  /** `orbital status`, once the server answers. */
  status: () => Promise<number>;
};

export async function runSetup({ io, sys, port, status }: SetupDeps): Promise<number> {
  const facts = await sys.facts();
  const plan = setupPlan(facts);
  if ('error' in plan) {
    io.err(plan.error);
    return 1;
  }
  let changed = false;
  if (plan.steps.length > 0) {
    io.out('These steps need root, so they run with sudo:');
    for (const step of plan.steps) io.out(`  sudo ${step.argv.join(' ')}    (${step.why})`);
    for (const step of plan.steps) {
      const code = await sys.sudo(step);
      if (code !== 0) {
        io.err(`sudo ${step.argv.join(' ')} failed (exit ${code}). Nothing after it ran; run orbital setup again once it can.`);
        return 1;
      }
    }
    changed = true;
  }

  // Lingering starts the user's manager on its own time: give it a moment to come up.
  const managerUntil = io.now() + USER_MANAGER_WAIT_MS;
  let reload = await sys.run(['systemctl', '--user', 'daemon-reload']);
  while (reload.code !== 0 && io.now() < managerUntil) {
    await io.sleep(POLL_MS);
    reload = await sys.run(['systemctl', '--user', 'daemon-reload']);
  }
  if (reload.code !== 0) {
    io.err(userManagerLine(facts.user, reload.stderr));
    return 1;
  }
  const enabled = (await sys.run(['systemctl', '--user', 'is-enabled', 'orbital'])).stdout.trim() === 'enabled';
  const active = (await sys.run(['systemctl', '--user', 'is-active', 'orbital'])).stdout.trim() === 'active';
  if (!enabled || !active) {
    io.out('Starting Orbital: systemctl --user enable --now orbital');
    const start = await sys.run(['systemctl', '--user', 'enable', '--now', 'orbital']);
    if (start.code !== 0) {
      io.err(`systemctl --user enable --now orbital failed: ${start.stderr.trim() || `exit ${start.code}`}`);
      return 1;
    }
    changed = true;
  }

  if (!(await waitHealthy(io, sys, port))) {
    io.err(`Orbital did not answer on port ${port} within ${SETUP_START_TIMEOUT_MS / 1000} s. Its log: journalctl --user -u orbital`);
    return 1;
  }
  io.out(changed ? `Orbital is set up for ${facts.user}.` : `Orbital is set up for ${facts.user} already; nothing changed.`);
  io.out('');
  return status();
}

async function waitHealthy(io: Io, sys: SetupSys, port: number): Promise<boolean> {
  const until = io.now() + SETUP_START_TIMEOUT_MS;
  for (;;) {
    if (await sys.healthy(port)) return true;
    if (io.now() >= until) return false;
    await io.sleep(POLL_MS);
  }
}

/** `systemctl --user` could not reach this user's manager: a `su` or `sudo -u` shell has none. */
export function userManagerLine(user: string, stderr: string): string {
  const said = stderr.trim();
  return [
    `systemctl --user could not reach your user's systemd${said ? ` (${said})` : ''}.`,
    `Log in as ${user} directly (ssh ${user}@this-machine, or machinectl shell ${user}@) and run orbital setup again.`,
  ].join(' ');
}

/** The real machine. */
export class SystemSetup implements SetupSys {
  async facts(): Promise<SetupFacts> {
    const me = userInfo();
    const exists = (path: string) => access(path).then(() => true, () => false);
    const recordedUser = await readFile(SERVICE_USER_FILE, 'utf8').then((s) => s.trim(), () => null);
    const dir = await stat(UPDATE_REQUEST_DIR).then(
      (s) => ({ uid: s.uid, gid: s.gid, mode: s.mode, isDirectory: s.isDirectory() }),
      () => null,
    );
    const word = async (argv: string[]) => (await this.run(argv)).stdout.trim();
    return {
      platform: process.platform,
      uid: process.getuid?.() ?? -1,
      user: me.username,
      gid: me.gid,
      recordedUser,
      unitInstalled: await exists(USER_UNIT_FILE),
      requestDir: dir,
      pathUnit: {
        enabled: (await word(['systemctl', 'is-enabled', 'orbital-update.path'])) === 'enabled',
        active: (await word(['systemctl', 'is-active', 'orbital-update.path'])) === 'active',
      },
      linger: await exists(`${LINGER_DIR}/${me.username}`),
    };
  }

  run(argv: string[]): Promise<RunResult> {
    // A shell from `su` or `sudo -u` has no XDG_RUNTIME_DIR, which `systemctl
    // --user` needs to find the manager that lingering starts.
    const uid = process.getuid?.();
    const env = process.env.XDG_RUNTIME_DIR || uid === undefined
      ? process.env
      : { ...process.env, XDG_RUNTIME_DIR: `/run/user/${uid}` };
    return new Promise((resolve) => {
      execFile(argv[0], argv.slice(1), { encoding: 'utf8', env }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 127) : 0;
        resolve({ code, stdout, stderr: stderr || (err && typeof err.code !== 'number' ? err.message : '') });
      });
    });
  }

  sudo(step: RootStep): Promise<number> {
    return new Promise((resolve) => {
      // stdin is the step's input when it has one; sudo asks for the password on the terminal itself.
      const child = spawn('sudo', step.argv, {
        stdio: [step.input === undefined ? 'inherit' : 'pipe', 'ignore', 'inherit'],
      });
      if (step.input !== undefined) child.stdin?.end(step.input);
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code ?? 1));
    });
  }

  async healthy(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) return false;
      const body = (await res.json()) as { app?: unknown };
      return body.app === 'orbital';
    } catch {
      return false;
    }
  }
}
