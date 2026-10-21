import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CANCELLED_MESSAGE,
  DESIGN_CANCEL_GRACE_MS,
  LOGIN_TIMEOUT_MS,
  LoginService,
  TIMED_OUT_MESSAGE,
  WRONG_CODE_MESSAGE,
  type LoginChild,
  type LoginServiceDeps,
  type ProfileLogin,
} from '../src/login/service.js';
import { SILENT_BROWSER } from '../src/login/parse.js';

/**
 * `LoginService` against a fake `claude` (spec
 * 2026-10-21-log-in-from-orbital-design § 1, § 3): the processes are
 * scripted, the status commands answer what each test says.
 */

const HOME = '/Users/someone';
const LOCAL = { deviceId: null, name: 'Studio' };
const PIXEL = { deviceId: 'dev-pixel', name: 'Pixel 8' };
const MANUAL = 'https://claude.ai/oauth/authorize?state=s';

class FakeChild implements LoginChild {
  written: string[] = [];
  stdinClosed = false;
  killed = false;
  private out: ((c: string) => void)[] = [];
  private exits: ((code: number | null) => void)[] = [];
  constructor(readonly args: string[], readonly env: Record<string, string>) {}
  onStdout(cb: (c: string) => void) { this.out.push(cb); }
  onStderr() {}
  onExit(cb: (code: number | null) => void) { this.exits.push(cb); }
  write(text: string) { this.written.push(text); }
  closeStdin() { this.stdinClosed = true; }
  kill() { this.killed = true; this.exit(null); }
  print(text: string) { for (const cb of this.out) cb(text); }
  exit(code: number | null) {
    const exits = this.exits.splice(0);
    for (const cb of exits) cb(code);
  }
}

interface Harness {
  service: LoginService;
  children: FakeChild[];
  published: ProfileLogin[];
  status: { auth: string; design: string };
  delivered: { sessionId: string; text: string }[];
  toSession: { sessionId: string; payload: any }[];
  ended: Set<string>;
  limitWaiting: Set<string>;
}

function harness(over: Partial<LoginServiceDeps> = {}): Harness {
  const children: FakeChild[] = [];
  const published: ProfileLogin[] = [];
  const status = { auth: '{"loggedIn":false}', design: '{"available":true,"signed_in":false}' };
  const delivered: { sessionId: string; text: string }[] = [];
  const toSession: { sessionId: string; payload: any }[] = [];
  const ended = new Set<string>();
  const limitWaiting = new Set<string>();
  const dirs: Record<number, string> = { 1: `${HOME}/.claude`, 2: `${HOME}/.claude-work` };
  const service = new LoginService({
    cliPath: '/bin/claude',
    dirPath: (id) => dirs[id],
    accountEmail: () => 'old@example.com',
    publish: (l) => published.push(l),
    publishToSession: (sessionId, payload) => toSession.push({ sessionId, payload }),
    republish: () => {},
    sessions: {
      title: (id) => `title of ${id}`,
      isEnded: (id) => ended.has(id),
      isLimitWaiting: (id) => limitWaiting.has(id),
    },
    continueText: () => 'Continue where you left off.',
    baseEnv: { PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', BROWSER: 'firefox' },
    home: HOME,
    spawn: (_file, args, opts) => {
      const child = new FakeChild(args, opts.env);
      children.push(child);
      return child;
    },
    runStatus: async (_file, args) => ({ stdout: args[0] === 'auth' ? status.auth : status.design }),
    ...over,
  });
  service.deliver = async (sessionId, text) => {
    delivered.push({ sessionId, text });
    return { outcome: 'sent', uuid: `u-${sessionId}` };
  };
  return { service, children, published, status, delivered, toSession, ended, limitWaiting };
}

const loginOf = (h: Harness, dir = 1) => h.service.snapshot(dir);

afterEach(() => {
  vi.useRealTimers();
});

describe('running a login', () => {
  it('runs one login per profile and kind; a second start answers the running one', () => {
    const h = harness();
    h.service.start(1, 'claude', LOCAL);
    h.service.start(1, 'claude', LOCAL);
    expect(h.children).toHaveLength(1);
    h.service.start(1, 'design', LOCAL);
    h.service.start(2, 'claude', LOCAL);
    expect(h.children.map((c) => c.args.join(' '))).toEqual(['auth login', 'design-login --json', 'auth login']);
  });

  it('refuses an unknown profile, and any start without an executable', () => {
    expect(harness().service.start(9, 'claude', LOCAL)).toEqual({ ok: false, error: 'not_found' });
    expect(harness({ cliPath: null }).service.start(1, 'claude', LOCAL)).toEqual({ ok: false, error: 'no_cli' });
  });

  it('a login from another device runs with BROWSER silenced and answers manualOnly; one on this Mac has no BROWSER', () => {
    const h = harness();
    h.service.start(1, 'claude', PIXEL);
    h.service.start(2, 'claude', LOCAL);
    const [remote, local] = h.children;
    expect(remote.env.BROWSER).toBe(SILENT_BROWSER);
    expect(local.env).not.toHaveProperty('BROWSER');
    expect(local.env).not.toHaveProperty('CLAUDECODE');
    expect(loginOf(h, 1).runs.claude).toMatchObject({ manualOnly: true, step: 'code', startedBy: PIXEL });
    expect(loginOf(h, 2).runs.claude).toMatchObject({ manualOnly: false, step: 'browser', startedBy: LOCAL });
  });

  it('publishes the manual URL as the CLI prints it', () => {
    const h = harness();
    h.service.start(1, 'claude', LOCAL);
    h.children[0].print(`Opening browser to sign in…\nIf the browser didn't open, visit: ${MANUAL}\nPaste code here if prompted > `);
    expect(h.published.at(-1)?.runs.claude?.manualUrl).toBe(MANUAL);
  });

  it('hands a claude code over as a line and a design code as JSON; the step becomes checking', () => {
    const h = harness();
    h.service.start(1, 'claude', LOCAL);
    h.service.start(1, 'design', LOCAL);
    expect(h.service.code(1, 'claude', 'abc#def')).toMatchObject({ ok: true });
    h.service.code(1, 'design', 'xyz#s');
    expect(h.children[0].written).toEqual(['abc#def\n']);
    expect(h.children[1].written).toEqual(['{"code":"xyz#s"}\n']);
    expect(loginOf(h).runs.claude?.step).toBe('checking');
  });

  it('answers no_login for a code or a cancel with nothing running', () => {
    const h = harness();
    expect(h.service.code(1, 'claude', 'abc')).toEqual({ ok: false, error: 'no_login' });
    expect(h.service.cancel(1, 'design')).toEqual({ ok: false, error: 'no_login' });
  });

  it('decides success by the status read after exit, not by what the CLI printed', async () => {
    const h = harness();
    h.service.start(1, 'claude', LOCAL);
    h.children[0].print('Login successful.\n');
    h.children[0].exit(0);
    await vi.waitFor(() => expect(loginOf(h).runs.claude?.state).toBe('failed'));

    h.service.start(1, 'claude', LOCAL);
    h.status.auth = '{"loggedIn":true,"email":"new@example.com","orgName":"Acme","subscriptionType":"max"}';
    h.children[1].exit(1);
    await vi.waitFor(() => expect(loginOf(h).runs.claude?.state).toBe('succeeded'));
    expect(loginOf(h).runs.claude?.account).toBe('new@example.com');
    expect(loginOf(h).account).toEqual({ read: true, loggedIn: true, email: 'new@example.com', orgName: 'Acme', plan: 'max' });
  });

  it('a failed login that was handed a code says the code was wrong; otherwise the CLI\'s last words', async () => {
    const h = harness();
    h.service.start(1, 'claude', LOCAL);
    h.service.code(1, 'claude', 'bad');
    h.children[0].print('Paste code here if prompted > Login failed: Request failed with status code 400\n');
    h.children[0].exit(1);
    await vi.waitFor(() => expect(loginOf(h).runs.claude?.message).toBe(WRONG_CODE_MESSAGE));

    h.service.start(1, 'claude', LOCAL);
    h.children[1].print('Login failed: no network\n');
    h.children[1].exit(1);
    await vi.waitFor(() => expect(loginOf(h).runs.claude?.message).toBe('Login failed: no network'));
  });

  it('a failed design sign-in carries the CLI\'s done message', async () => {
    const h = harness();
    h.service.start(1, 'design', LOCAL);
    h.children[0].print('{"event":"pages","url":"http://localhost:5000/cb","manual_url":"https://claude.ai/d","manual_first":false}\n');
    expect(loginOf(h).runs.design).toMatchObject({ url: 'http://localhost:5000/cb', manualUrl: 'https://claude.ai/d', step: 'browser' });
    h.children[0].print('{"event":"done","ok":false,"message":"The sign-in could not be saved."}\n');
    h.children[0].exit(1);
    await vi.waitFor(() => expect(loginOf(h).runs.design?.message).toBe('The sign-in could not be saved.'));
  });

  it('cancels a claude login by killing it, a design one by closing stdin first', () => {
    vi.useFakeTimers();
    const h = harness();
    h.service.start(1, 'claude', LOCAL);
    h.service.start(1, 'design', LOCAL);
    expect(h.service.cancel(1, 'claude')).toMatchObject({ ok: true });
    expect(h.children[0].killed).toBe(true);
    h.service.cancel(1, 'design');
    expect(h.children[1].stdinClosed).toBe(true);
    expect(h.children[1].killed).toBe(false);
    vi.advanceTimersByTime(DESIGN_CANCEL_GRACE_MS);
    expect(h.children[1].killed).toBe(true);
    expect(loginOf(h).runs.claude).toMatchObject({ state: 'failed', message: CANCELLED_MESSAGE });
    expect(loginOf(h).runs.design).toMatchObject({ state: 'failed', message: CANCELLED_MESSAGE });
  });

  it('cancels a claude login nobody finished once LOGIN_TIMEOUT_MS is up', () => {
    vi.useFakeTimers();
    const h = harness();
    h.service.start(1, 'claude', LOCAL);
    vi.advanceTimersByTime(LOGIN_TIMEOUT_MS - 1);
    expect(loginOf(h).runs.claude?.state).toBe('running');
    vi.advanceTimersByTime(1);
    expect(h.children[0].killed).toBe(true);
    expect(loginOf(h).runs.claude).toMatchObject({ state: 'failed', message: TIMED_OUT_MESSAGE });
  });

  it('kills every running login on dispose', () => {
    const h = harness();
    h.service.start(1, 'claude', LOCAL);
    h.service.start(2, 'design', LOCAL);
    h.service.dispose();
    expect(h.children.every((c) => c.killed)).toBe(true);
  });

  it('reads a status that answers nothing it knows as unknown, not as logged out', async () => {
    const h = harness();
    h.status.auth = 'Error: keychain locked';
    const login = await h.service.state(1);
    expect(login?.account.read).toBe(false);
    expect(login?.design).toEqual({ read: true, available: true, signedIn: false });
  });
});

describe('continuing after a login', () => {
  const lost = { loginLost: true, designLoginLost: false };

  async function succeed(h: Harness, dir = 1) {
    h.service.start(dir, 'claude', LOCAL);
    h.status.auth = '{"loggedIn":true,"email":"new@example.com"}';
    h.children.at(-1)!.exit(0);
    await vi.waitFor(() => expect(loginOf(h, dir).runs.claude?.state).toBe('succeeded'));
  }

  it('sends the continuation text once to every session that stopped on the login, with the notice and the turn', async () => {
    const h = harness();
    h.service.turnEnded('s1', 1, lost);
    expect(h.service.waitFor('s1')).toEqual({ kind: 'claude', claudeDirId: 1, running: false, startedBy: null });
    h.service.start(1, 'claude', PIXEL);
    expect(h.service.waitFor('s1')).toMatchObject({ running: true, startedBy: 'Pixel 8' });
    expect(loginOf(h).runs.claude?.waiting).toEqual([{ sessionId: 's1', title: 'title of s1' }]);

    h.status.auth = '{"loggedIn":true,"email":"new@example.com"}';
    h.children[0].exit(0);
    await vi.waitFor(() => expect(h.delivered).toEqual([{ sessionId: 's1', text: 'Continue where you left off.' }]));
    const [notice, turn] = h.toSession.map((m) => m.payload.message);
    expect(notice.notice).toEqual({
      level: 'info', kind: 'login_restored',
      login: { kind: 'claude', email: 'new@example.com', previousEmail: 'old@example.com', continued: true },
    });
    expect(turn).toMatchObject({ role: 'user', text: 'Continue where you left off.', uuid: 'u-s1' });
    expect(h.service.waitFor('s1')).toBeNull();

    // A second login continues nothing: the list is empty now.
    await succeed(h);
    expect(h.delivered).toHaveLength(1);
  });

  it('leaves out a session the user wrote to since, an ended one, one left to a usage limit and one of another profile', async () => {
    const h = harness();
    for (const id of ['wrote', 'ended', 'limit', 'kept']) h.service.turnEnded(id, 1, lost);
    h.service.turnEnded('other', 2, lost);
    h.service.forget('wrote');
    h.ended.add('ended');
    h.limitWaiting.add('limit');
    await succeed(h, 1);
    await vi.waitFor(() => expect(h.delivered.map((d) => d.sessionId)).toEqual(['kept']));
    expect(h.service.waitFor('other')).toMatchObject({ claudeDirId: 2 });
  });

  it('a later turn that did not end on a lost login takes the session off the list', () => {
    const h = harness();
    h.service.turnEnded('s1', 1, lost);
    h.service.turnEnded('s1', 1, { loginLost: false, designLoginLost: false });
    expect(h.service.waitFor('s1')).toBeNull();
  });

  it('a design sign-in continues the sessions on the design list only', async () => {
    const h = harness();
    h.service.turnEnded('design', 1, { loginLost: false, designLoginLost: true });
    h.service.turnEnded('claude', 1, lost);
    h.service.start(1, 'design', LOCAL);
    h.status.design = '{"available":true,"signed_in":true}';
    h.children[0].exit(0);
    await vi.waitFor(() => expect(h.delivered.map((d) => d.sessionId)).toEqual(['design']));
    expect(h.service.waitFor('claude')).toMatchObject({ kind: 'claude' });
  });
});
