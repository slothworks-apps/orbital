import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import type { Io } from '../src/cli/io.js';
import { DEFAULT_PORT } from '../src/config.js';
import { runSetup, setupPlan, unitPort, type RootStep, type RunResult, type SetupFacts, type SetupSys } from '../src/cli/setup.js';
import { SERVICE_USER_FILE } from '../src/cli/target.js';
import { UPDATE_REQUEST_DIR } from '../src/update/backends.js';

/** A machine where setup has run for `ana` (uid 1000). */
const done: SetupFacts = {
  platform: 'linux',
  uid: 1000,
  user: 'ana',
  recordedUser: 'ana',
  unitInstalled: true,
  stateDir: { uid: 0, gid: 0, mode: 0o40755, isDirectory: true },
  requestDir: { uid: 1000, gid: 0, mode: 0o40700, isDirectory: true },
  pathUnit: { enabled: true, active: true },
  linger: true,
};

/** A machine right after `apt install orbital`. */
const fresh: SetupFacts = {
  ...done,
  recordedUser: null,
  stateDir: null,
  requestDir: null,
  pathUnit: { enabled: false, active: false },
  linger: false,
};

const argvs = (plan: ReturnType<typeof setupPlan>) => ('steps' in plan ? plan.steps.map((s) => s.argv.join(' ')) : plan);

describe('setupPlan', () => {
  it("on a fresh install: the user, root's state dir, the request directory as <user>:root 0700, the updater, lingering", () => {
    expect(argvs(setupPlan(fresh))).toEqual([
      'install -d -m 0755 /etc/orbital',
      `tee ${SERVICE_USER_FILE}`,
      'install -d -o root -g root -m 0755 /var/lib/orbital',
      `install -d -o ana -g root -m 0700 ${UPDATE_REQUEST_DIR}`,
      'systemctl enable --now orbital-update.path',
      'loginctl enable-linger ana',
    ]);
    const plan = setupPlan(fresh);
    expect('steps' in plan && plan.steps[1].input).toBe('ana\n');
  });

  it('asks for nothing once everything is in place', () => {
    expect(setupPlan(done)).toEqual({ steps: [] });
  });

  it('repairs only what is off', () => {
    expect(argvs(setupPlan({ ...done, requestDir: { ...done.requestDir!, mode: 0o40770 } }))).toEqual([
      `install -d -o ana -g root -m 0700 ${UPDATE_REQUEST_DIR}`,
    ]);
    // The old layout (root:<group> 0770) is repaired: a shared group must not reach it.
    expect(argvs(setupPlan({ ...done, requestDir: { uid: 0, gid: 1000, mode: 0o40770, isDirectory: true } }))).toHaveLength(1);
    expect(argvs(setupPlan({ ...done, requestDir: { ...done.requestDir!, gid: 1000 } }))).toHaveLength(1);
    expect(argvs(setupPlan({ ...done, stateDir: { ...done.stateDir!, mode: 0o40777 } }))).toEqual([
      'install -d -o root -g root -m 0755 /var/lib/orbital',
    ]);
    expect(argvs(setupPlan({ ...done, requestDir: { ...done.requestDir!, isDirectory: false } }))).toHaveLength(1);
    expect(argvs(setupPlan({ ...done, pathUnit: { enabled: true, active: false } }))).toEqual([
      'systemctl enable --now orbital-update.path',
    ]);
    expect(argvs(setupPlan({ ...done, linger: false }))).toEqual(['loginctl enable-linger ana']);
    expect(argvs(setupPlan({ ...done, recordedUser: '' }))).toHaveLength(2);
  });

  it('refuses root, another recorded user, a Mac and a machine without the package', () => {
    expect(setupPlan({ ...fresh, uid: 0, user: 'root' })).toEqual({ error: expect.stringMatching(/not as root/) });
    expect(setupPlan({ ...done, recordedUser: 'bob' })).toEqual({ error: expect.stringMatching(/set up for bob/) });
    // A name that is no user name is not echoed.
    expect(setupPlan({ ...done, recordedUser: 'x; rm -rf /' })).toEqual({ error: expect.stringMatching(/another user/) });
    expect(setupPlan({ ...done, platform: 'darwin' })).toHaveProperty('error');
    expect(setupPlan({ ...fresh, unitInstalled: false })).toHaveProperty('error');
  });

  it('is a command of its own, with no arguments', () => {
    expect(parseArgs(['setup'])).toEqual({ kind: 'setup' });
    expect(parseArgs(['setup', 'now']).kind).toBe('usage');
    expect(parseArgs(['setup', '--yes']).kind).toBe('usage');
  });
});

function fakeSys(facts: SetupFacts, unit: { enabled: boolean; active: boolean }, healthyAfter = 0, environment = 'Environment=ORBITAL_HEADLESS=1\n') {
  const healthPorts: number[] = [];
  const sudo: RootStep[] = [];
  const ran: string[] = [];
  let polls = 0;
  const sys: SetupSys = {
    facts: () => Promise.resolve(facts),
    run: (argv): Promise<RunResult> => {
      const line = argv.join(' ');
      ran.push(line);
      const out = (stdout: string) => Promise.resolve({ code: 0, stdout, stderr: '' });
      if (line.endsWith('is-enabled orbital')) return out(unit.enabled ? 'enabled\n' : 'disabled\n');
      if (line.endsWith('is-active orbital')) return out(unit.active ? 'active\n' : 'inactive\n');
      return out('');
    },
    sudo: (step) => {
      sudo.push(step);
      return Promise.resolve(0);
    },
    healthy: (port) => {
      healthPorts.push(port);
      return Promise.resolve(polls++ >= healthyAfter);
    },
    unitEnvironment: () => Promise.resolve(environment),
  };
  return { sys, sudo, ran, healthPorts };
}

function io() {
  const lines: string[] = [];
  let now = 0;
  const value: Io = {
    out: (l) => void lines.push(l),
    err: (l) => void lines.push(`ERR ${l}`),
    ask: () => Promise.resolve(null),
    askSecret: () => Promise.resolve(null),
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    trap: () => ({ signal: new Promise(() => {}), release: () => {} }),
    now: () => now,
  };
  return { io: value, lines };
}

describe('unitPort', () => {
  it("reads ORBITAL_PORT from the unit's environment, else the default", () => {
    expect(unitPort('Environment=ORBITAL_HEADLESS=1 ORBITAL_PORT=4800 ORBITAL_RESOLVE_PATH=1\n')).toBe(4800);
    expect(unitPort('Environment=ORBITAL_PORT=4801')).toBe(4801);
    expect(unitPort('Environment=ORBITAL_HEADLESS=1\n')).toBe(DEFAULT_PORT);
    expect(unitPort('')).toBe(DEFAULT_PORT);
    expect(unitPort('Environment=ORBITAL_PORT=99999')).toBe(DEFAULT_PORT);
    expect(unitPort('Environment=XORBITAL_PORT=4800')).toBe(DEFAULT_PORT);
  });

  it('waits for and reports the port the unit uses', async () => {
    const { sys, healthPorts } = fakeSys(done, { enabled: true, active: true }, 0, 'Environment=ORBITAL_PORT=4800\n');
    let asked = 0;
    expect(await runSetup({ io: io().io, sys, status: (port) => Promise.resolve((asked = port) && 0) })).toBe(0);
    expect(healthPorts).toEqual([4800]);
    expect(asked).toBe(4800);
  });
});

describe('runSetup', () => {
  it('runs the root steps, starts the unit, waits for it and prints the status', async () => {
    const { sys, sudo, ran } = fakeSys(fresh, { enabled: false, active: false }, 3);
    const t = io();
    let status = 0;
    const code = await runSetup({ io: t.io, sys, status: () => Promise.resolve(++status && 0) });
    expect(code).toBe(0);
    expect(sudo).toHaveLength(6);
    expect(ran).toContain('systemctl --user enable --now orbital');
    expect(status).toBe(1);
    expect(t.lines.some((l) => l.startsWith('  sudo loginctl enable-linger ana'))).toBe(true);
  });

  it('a second run changes nothing and says so', async () => {
    const { sys, sudo, ran } = fakeSys(done, { enabled: true, active: true });
    const t = io();
    expect(await runSetup({ io: t.io, sys, status: () => Promise.resolve(0) })).toBe(0);
    expect(sudo).toEqual([]);
    expect(ran).not.toContain('systemctl --user enable --now orbital');
    expect(t.lines.join('\n')).toMatch(/nothing changed/);
  });

  it('stops at the first root step that fails', async () => {
    const { sys, sudo } = fakeSys(fresh, { enabled: false, active: false });
    sys.sudo = (step) => {
      sudo.push(step);
      return Promise.resolve(1);
    };
    const t = io();
    expect(await runSetup({ io: t.io, sys, status: () => Promise.resolve(0) })).toBe(1);
    expect(sudo).toHaveLength(1);
  });

  it('gives up when the server never answers', async () => {
    const { sys } = fakeSys(done, { enabled: true, active: true }, Number.POSITIVE_INFINITY);
    const t = io();
    expect(await runSetup({ io: t.io, sys, status: () => Promise.resolve(0) })).toBe(1);
    expect(t.lines.join('\n')).toMatch(/journalctl --user -u orbital/);
  });
});
