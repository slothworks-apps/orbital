import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { sessions } from '../src/db/schema.js';
import { API_TOKEN_COOKIE } from '../src/auth/token.js';
import { isAllowed } from '../src/remote/allowlist.js';
import { Scrollback } from '../src/terminal/scrollback.js';
import { commandLabel, folderLabel, foregroundCommand, parsePs } from '../src/terminal/label.js';
import { TerminalStore, parseInput, shellEnv } from '../src/terminal/store.js';
import { makeTmpDir } from './tmp.js';

const TOKEN = 'test-token-0123456789';
const SH = { file: '/bin/sh', args: [] };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Scrollback', () => {
  it('keeps everything under the limit', () => {
    const s = new Scrollback(100);
    s.push('a\n');
    s.push('b\n');
    expect(s.text()).toBe('a\nb\n');
  });
  it('drops the oldest output, from the next line start, once past twice the limit', () => {
    const s = new Scrollback(12);
    s.push('line one\nline two\nline three\n');
    expect(s.text()).toBe('line three\n');
  });
});

describe('tab labels', () => {
  it('cuts a command down to what it does', () => {
    for (const [args, label] of [
      ['npm run dev', 'npm run dev'],
      ['node /usr/local/lib/node_modules/npm/bin/npm-cli.js run dev', 'npm run dev'],
      ['npm install', 'npm install'],
      ['npm', 'npm'],
      ['pnpm run --silent build', 'pnpm run build'],
      ['npx vitest run src/terminal', 'vitest'],
      ['npx --yes vitest', 'vitest'],
      ['node /x/node_modules/.bin/vite.js --port 5174', 'vite'],
      ['/usr/bin/git rebase -i HEAD~3', 'git rebase'],
      ['python3 manage.py runserver', 'manage'],
      ['-zsh', 'zsh'],
      ['vim src/a.ts', 'vim'],
      ['  ', ''],
    ]) expect(commandLabel(args), args).toBe(label);
  });
  it('names a folder by its base name, and home as ~', () => {
    expect(folderLabel('/Users/a/orbital/web', '/Users/a')).toBe('web');
    expect(folderLabel('/Users/a', '/Users/a')).toBe('~');
    expect(folderLabel('/', '/Users/a')).toBe('/');
  });
  it('finds the foreground group leader, or none at a prompt', () => {
    const rows = parsePs([
      '27778 27778 27780 /bin/zsh -l',
      '27780 27780 27780 npm run dev',
      '27781 27780 27780 sh -c vite',
      '',
    ].join('\n'));
    expect(foregroundCommand(rows, 27778)).toBe('npm run dev');
    expect(foregroundCommand(parsePs('27778 27778 27778 /bin/zsh -l\n'), 27778)).toBeNull();
    expect(foregroundCommand([], 27778)).toBeNull();
  });
});

describe('shellEnv', () => {
  it("leaves out Orbital's own variables and sets the terminal type", () => {
    const env = shellEnv({ ORBITAL_DATA_DIR: '/x', ORBITAL_PARENT_PID: '1', ELECTRON_RUN_AS_NODE: '1', HOME: '/h', LANG: 'cs_CZ.UTF-8' });
    expect(env).toMatchObject({ HOME: '/h', LANG: 'cs_CZ.UTF-8', TERM: 'xterm-256color' });
    expect(Object.keys(env).filter((k) => k.startsWith('ORBITAL_') || k === 'ELECTRON_RUN_AS_NODE')).toEqual([]);
  });
  it('gives a shell without a locale a UTF-8 one', () => {
    expect(shellEnv({ HOME: '/h' }).LANG).toBe('en_US.UTF-8');
  });
});

describe('parseInput', () => {
  it('reads input and resize, and nothing else', () => {
    expect(parseInput('{"type":"input","data":"ls\\r"}')).toEqual({ type: 'input', data: 'ls\r' });
    expect(parseInput('{"type":"resize","cols":120,"rows":40}')).toEqual({ type: 'resize', cols: 120, rows: 40 });
    for (const raw of ['ls', '{"type":"input"}', '{"type":"resize","cols":0,"rows":40}', '{"type":"resize","cols":1.5,"rows":4}', 'null', '[]']) {
      expect(parseInput(raw), raw).toBeNull();
    }
  });
});

describe('TerminalStore', () => {
  const stores: TerminalStore[] = [];
  afterEach(() => { for (const s of stores.splice(0)) s.dispose(); });
  function store(): TerminalStore {
    const s = new TerminalStore({ shell: SH, env: { PATH: process.env.PATH, ORBITAL_SECRET: 'x' } });
    stores.push(s);
    return s;
  }

  it('closing a terminal ends what runs in it', async () => {
    const terminals = store();
    const t = terminals.open('s1', makeTmpDir('term'));
    const output: string[] = [];
    const socket = fakeSocket(output);
    terminals.attach(t.id, socket as any);
    socket.input('sh -c \'echo CHILD:$$; exec sleep 1000\'\n');
    const child = await vi.waitFor(() => {
      const m = output.join('').match(/CHILD:(\d+)/);
      expect(m).not.toBeNull();
      return Number(m![1]);
    });
    expect(alive(child)).toBe(true);
    expect(terminals.close(t.id)).toBe(true);
    await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 5000 });
    expect(terminals.list('s1')).toEqual([]);
  });

  it('ending the session closes only its terminals', () => {
    const terminals = store();
    const cwd = makeTmpDir('term');
    terminals.open('s1', cwd);
    terminals.open('s1', cwd);
    const other = terminals.open('s2', cwd);
    terminals.closeSession('s1');
    expect(terminals.list('s1')).toEqual([]);
    expect(terminals.list('s2').map((t) => t.id)).toEqual([other.id]);
  });

  it('the tab follows the foreground command and the folder', async () => {
    const terminals = store();
    const cwd = makeTmpDir('term');
    mkdirSync(join(cwd, 'web'));
    const t = terminals.open('s1', cwd);
    const socket = fakeSocket([]);
    terminals.attach(t.id, socket as any);
    expect(t.label).toBe(basename(cwd));
    socket.input('sleep 30\n');
    await vi.waitFor(() => expect(terminals.get(t.id)).toMatchObject({ label: 'sleep', busy: true }), { timeout: 5000 });
    socket.input('\x03');
    socket.input('cd web\n');
    await vi.waitFor(() => expect(terminals.get(t.id)).toMatchObject({ label: 'web', busy: false }), { timeout: 5000 });
    expect(socket.controls).toContainEqual({ type: 'status', label: 'sleep', busy: true });
  });

  it('a new shell starts in an exited tab, and only there', async () => {
    const terminals = store();
    const t = terminals.open('s1', makeTmpDir('term'));
    expect(terminals.restart(t.id)).toBe('running');
    const output: string[] = [];
    const socket = fakeSocket(output);
    terminals.attach(t.id, socket as any);
    socket.input('echo FIRST; exit 1\n');
    await vi.waitFor(() => expect(terminals.get(t.id)?.exitCode).toBe(1));
    const restarted = terminals.restart(t.id);
    expect(restarted).toMatchObject({ id: t.id, exitCode: null });
    expect(socket.controls).toContainEqual({ type: 'restart' });
    socket.input('echo SECOND\n');
    await vi.waitFor(() => expect(output.join('')).toMatch(/SECOND\r?\n/));
    expect(output.join('')).toContain('FIRST');
    expect(terminals.restart('nope')).toBe('missing');
  });

  it('an exited shell stays listed, with its code, until closed', async () => {
    const terminals = store();
    const t = terminals.open('s1', makeTmpDir('term'));
    const socket = fakeSocket([]);
    terminals.attach(t.id, socket as any);
    socket.input('exit 3\n');
    await vi.waitFor(() => expect(terminals.get(t.id)?.exitCode).toBe(3));
    expect(socket.controls).toContainEqual({ type: 'exit', exitCode: 3 });
    expect(terminals.list('s1')).toHaveLength(1);
  });
});

/** A socket as `attach` uses it: output arrives as binary, controls as JSON text. */
function fakeSocket(output: string[]) {
  const handlers: Record<string, ((...args: any[]) => void)[]> = {};
  const socket = {
    controls: [] as unknown[],
    send(data: Buffer | string, opts?: unknown, cb?: () => void) {
      if (typeof data === 'string') socket.controls.push(JSON.parse(data));
      else output.push(data.toString('utf8'));
      cb?.();
    },
    close() { for (const h of handlers.close ?? []) h(); },
    on(event: string, h: (...args: any[]) => void) { (handlers[event] ??= []).push(h); },
    input(data: string) {
      for (const h of handlers.message ?? []) h(Buffer.from(JSON.stringify({ type: 'input', data })), false);
    },
  };
  return socket;
}

describe('terminals through the server', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(): Promise<{ port: number; cwd: string }> {
    const dir = makeTmpDir('terminals');
    const dbPath = join(dir, 'index.db');
    app = await buildServer({ dbPath, claudeDir: dir, dataDir: dir, apiToken: TOKEN, terminals: { shell: SH } });
    const cwd = makeTmpDir('cwd');
    const db = openDb(dbPath);
    db.insert(sessions).values({ id: 's1', projectDir: '', cwd, source: 'web', lastAt: 1 }).run();
    db.$client.close();
    await app.listen({ host: '127.0.0.1', port: 0 });
    return { port: (app.server.address() as AddressInfo).port, cwd };
  }
  const auth = { authorization: `Bearer ${TOKEN}` };

  /** `output` collects from the first frame on: the replay arrives together with the open. */
  function connect(port: number, id: string, headers: Record<string, string>): Promise<{ ws: WebSocket; output: () => string }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${id}`, { headers });
      let text = '';
      const output = () => text;
      ws.on('message', (d, binary) => { if (binary) text += (d as Buffer).toString('utf8'); });
      ws.on('open', () => resolve({ ws, output }));
    });
  }

  it('opens a shell in the session folder and replays its output to a socket that comes back', async () => {
    const { port, cwd } = await start();
    const created = await app!.inject({ method: 'POST', url: '/api/sessions/s1/terminals', headers: auth, payload: {} });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const first = await connect(port, id, auth);
    first.ws.send(JSON.stringify({ type: 'input', data: 'pwd\n' }));
    await vi.waitFor(() => expect(first.output()).toContain(cwd));
    first.ws.close();

    const again = await connect(port, id, auth);
    await vi.waitFor(() => expect(again.output()).toContain(cwd));
    again.ws.close();

    const listed = await app!.inject({ method: 'GET', url: '/api/sessions/s1/terminals', headers: auth });
    expect(listed.json().terminals).toMatchObject([{ id, sessionId: 's1', cwd, exitCode: null }]);
  });

  it('ending the session closes its terminals', async () => {
    await start();
    await app!.inject({ method: 'POST', url: '/api/sessions/s1/terminals', headers: auth, payload: {} });
    await app!.inject({ method: 'POST', url: '/api/sessions/s1/end', headers: auth, payload: {} });
    const listed = await app!.inject({ method: 'GET', url: '/api/sessions/s1/terminals', headers: auth });
    expect(listed.json().terminals).toEqual([]);
  });

  // Through `inject`: a refused upgrade on a real socket holds `app.close()`
  // open (fix a-refused-websocket-upgrade-holds-the-server-open).
  it('refuses a terminal socket without the token, or from a foreign page', async () => {
    await start();
    const id = (await app!.inject({ method: 'POST', url: '/api/sessions/s1/terminals', headers: auth, payload: {} })).json().id;
    const upgrade = (headers: Record<string, string>) => app!.inject({
      method: 'GET',
      url: `/ws/terminal/${id}`,
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    expect((await upgrade({})).statusCode).toBe(401);
    expect((await upgrade({ authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect((await upgrade({ ...auth, origin: 'http://127.0.0.1:3000' })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'POST', url: '/api/sessions/s1/terminals', payload: {} })).statusCode).toBe(401);
  });

  it('answers 404 for a session or a terminal that does not exist', async () => {
    await start();
    expect((await app!.inject({ method: 'POST', url: '/api/sessions/nope/terminals', headers: auth, payload: {} })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'DELETE', url: '/api/terminals/nope', headers: auth })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'POST', url: '/api/terminals/nope/restart', headers: auth, payload: {} })).statusCode).toBe(404);
    const id = (await app!.inject({ method: 'POST', url: '/api/sessions/s1/terminals', headers: auth, payload: {} })).json().id;
    const running = await app!.inject({ method: 'POST', url: `/api/terminals/${id}/restart`, headers: auth, payload: {} });
    expect(running.statusCode).toBe(409);
  });

  it('a cookie carries the token as well as a bearer', async () => {
    const { port } = await start();
    const id = (await app!.inject({ method: 'POST', url: '/api/sessions/s1/terminals', headers: auth, payload: {} })).json().id;
    const { ws } = await connect(port, id, { cookie: `${API_TOKEN_COOKIE}=${TOKEN}` });
    ws.close();
  });
});

describe('the phone', () => {
  it('reaches no terminal route', () => {
    for (const [m, p] of [
      ['GET', '/api/sessions/s1/terminals'], ['POST', '/api/sessions/s1/terminals'],
      ['DELETE', '/api/terminals/t1'], ['POST', '/api/terminals/t1/restart'], ['GET', '/ws/terminal/t1'],
    ]) expect(isAllowed(m, p), `${m} ${p}`).toBe(false);
  });
});
