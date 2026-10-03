import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { sessions } from '../src/db/schema.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { McpConfig, addArgs, removeArgs, type McpCliRun } from '../src/mcp/config.js';
import { McpStatusTimeoutError } from '../src/runner/runner.js';
import { McpLoginUnsupportedError } from '../src/mcp/login.js';
import type { McpServerRow, SessionStatus } from '../src/types.js';
import { openTmpDb } from './tmp.js';

const ROWS: McpServerRow[] = [
  { name: 'gh', status: 'connected', origin: 'local', toolCount: 3, toggleable: true, editable: true },
  { name: 'shared', status: 'connected', origin: 'project', toggleable: true, editable: false },
  { name: 'orbital', status: 'connected', origin: 'built-in', toolCount: 1, toggleable: false, editable: false },
];

/** `~/.claude.json` as the routes read it: `gh` local to /w/proj, `odd` an entry the form cannot show. */
const CLAUDE_JSON = JSON.stringify({
  projects: {
    '/w/proj': {
      mcpServers: {
        gh: { type: 'stdio', command: 'npx', args: ['gh-mcp'], env: { T: 'secret' } },
        odd: { type: 'http', url: 'https://x', oauth: {} },
      },
    },
  },
});

const ADD_BODY = { name: 'linear', scope: 'user', transport: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer tok' } };

function makeApp(opts: { cliPath?: string | null; cli?: Array<{ ok: boolean; output: string }> } = {}) {
  const db = openTmpDb('mcp');
  db.insert(sessions).values([
    { id: 'run', projectDir: 'p', cwd: '/w/proj', lastAt: 1, source: 'web', permissionMode: 'plan', model: 'opus' },
    { id: 'asleep', projectDir: 'p', cwd: '/w/proj', lastAt: 1, source: 'web' },
  ]).run();
  const answers = [...(opts.cli ?? [])];
  const cliCalls: Array<{ args: string[]; cwd: string }> = [];
  const run: McpCliRun = async (_path, args, cwd) => {
    cliCalls.push({ args, cwd });
    return answers.shift() ?? { ok: true, output: '' };
  };
  const mcp = new McpConfig({
    cliPath: opts.cliPath === undefined ? '/bin/claude' : opts.cliPath,
    claudeJsonPath: '/fixture/.claude.json',
    run,
    readFile: () => CLAUDE_JSON,
    realpath: (p) => p,
  });
  const runner = {
    status: vi.fn((id: string): SessionStatus | undefined => (id === 'run' ? 'needs_input' : undefined)),
    pendingDecision: vi.fn((_id: string): any => null),
    mcpServers: vi.fn(async (_id: string): Promise<McpServerRow[]> => ROWS),
    reconnectMcpServer: vi.fn(async () => {}),
    toggleMcpServer: vi.fn(async () => {}),
    reloadMcpConfig: vi.fn(async () => {}),
    mcpLogin: vi.fn(async (_id: string, _name: string): Promise<{ authUrl: string }> => ({ authUrl: '' })),
    stopAndWait: vi.fn(async () => {}),
    start: vi.fn(async () => 'run'),
  };
  const registry = { get: vi.fn((_id: string): any => undefined) };
  const app = Fastify();
  registerMcpRoutes(app, {
    db, registry, runner, mcp, settings: { get: () => 'acceptEdits' },
  });
  return { app, runner, registry, cliCalls };
}

describe('MCP routes — the live session', () => {
  it('GET lists the servers', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/run/mcp' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ servers: ROWS });
  });

  it('404 for an unknown session, 409 for one not running here', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope/mcp' })).statusCode).toBe(404);
    const asleep = await app.inject({ method: 'GET', url: '/api/sessions/asleep/mcp' });
    expect(asleep.statusCode).toBe(409);
    expect(asleep.json().error).toBe('not_running');
  });

  it('504 when the session does not answer in time, 502 when it fails', async () => {
    const { app, runner } = makeApp();
    runner.mcpServers.mockRejectedValueOnce(new McpStatusTimeoutError('slow'));
    expect((await app.inject({ method: 'GET', url: '/api/sessions/run/mcp' })).statusCode).toBe(504);
    runner.mcpServers.mockRejectedValueOnce(new Error('control channel closed'));
    const failed = await app.inject({ method: 'GET', url: '/api/sessions/run/mcp' });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().message).toBe('control channel closed');
  });

  it('reconnect passes the name through and answers the new list', async () => {
    const { app, runner } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp/gh/reconnect' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ servers: ROWS });
    expect(runner.reconnectMcpServer).toHaveBeenCalledWith('run', 'gh');
    expect((await app.inject({ method: 'POST', url: '/api/sessions/run/mcp/nope/reconnect' })).statusCode).toBe(404);
  });

  it('enabled toggles a server; refuses a bad body, an unknown name and Orbital\'s own', async () => {
    const { app, runner } = makeApp();
    const url = (name: string) => `/api/sessions/run/mcp/${encodeURIComponent(name)}/enabled`;
    const res = await app.inject({ method: 'POST', url: url('shared'), payload: { enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ servers: ROWS });
    expect(runner.toggleMcpServer).toHaveBeenCalledWith('run', 'shared', false);
    expect((await app.inject({ method: 'POST', url: url('gh'), payload: { enabled: 'no' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: url('nope'), payload: { enabled: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: url('orbital'), payload: { enabled: false } })).statusCode).toBe(400);
    expect(runner.toggleMcpServer).toHaveBeenCalledTimes(1);
  });
});

describe('MCP routes — config', () => {
  it('GET config answers the definition of a user or local server', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/run/mcp/gh/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'gh', scope: 'local', transport: 'stdio', command: 'npx', args: ['gh-mcp'], env: { T: 'secret' },
    });
  });

  it('GET config: 400 for a server outside user/local or one it cannot read, 404 for an unknown one', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/sessions/run/mcp/shared/config' })).json().error).toBe('not_editable');
    const odd = await app.inject({ method: 'GET', url: '/api/sessions/run/mcp/odd/config' });
    expect(odd.statusCode).toBe(400);
    expect(odd.json().error).toBe('not_editable');
    expect((await app.inject({ method: 'GET', url: '/api/sessions/run/mcp/nope/config' })).statusCode).toBe(404);
  });

  it('add writes through the CLI in the session cwd and reloads the session', async () => {
    const { app, runner, cliCalls } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp', payload: ADD_BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ servers: ROWS, restartNeeded: false });
    expect(cliCalls).toEqual([{ args: addArgs(ADD_BODY as any), cwd: '/w/proj' }]);
    expect(runner.reloadMcpConfig).toHaveBeenCalledWith('run');
  });

  it('add asks for a restart when the session cannot reload', async () => {
    const { app, runner } = makeApp();
    runner.reloadMcpConfig.mockRejectedValueOnce(new Error("this session's CLI cannot reloadPlugins"));
    const res = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp', payload: ADD_BODY });
    expect(res.json().restartNeeded).toBe(true);
  });

  it('add: 400 for an invalid body and for the project scope', async () => {
    const { app, cliCalls } = makeApp();
    const bad = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp', payload: { ...ADD_BODY, url: 'nope' } });
    expect(bad.statusCode).toBe(400);
    const project = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp', payload: { ...ADD_BODY, scope: 'project' } });
    expect(project.statusCode).toBe(400);
    expect(project.json().error).toBe('project_scope');
    expect(cliCalls).toEqual([]);
  });

  it('503 when there is no CLI to write with', async () => {
    const { app } = makeApp({ cliPath: null });
    const res = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp', payload: ADD_BODY });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('cli_missing');
  });

  it('502 with the CLI output and the masked command when the CLI refuses', async () => {
    const { app } = makeApp({ cli: [{ ok: false, output: 'already exists' }] });
    const res = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp', payload: ADD_BODY });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe('cli_refused');
    expect(body.message).toBe('already exists');
    expect(body.command).toContain('claude mcp add-json --scope user linear');
    expect(body.command).not.toContain('Bearer tok');
  });

  it('edit removes the old and adds the new, and asks for a restart', async () => {
    const { app, cliCalls } = makeApp();
    const next = { name: 'github', scope: 'user', transport: 'stdio', command: 'gh-mcp', args: [], env: {} };
    const res = await app.inject({ method: 'PUT', url: '/api/sessions/run/mcp/gh', payload: next });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ servers: ROWS, restartNeeded: true });
    expect(cliCalls.map((c) => c.args)).toEqual([removeArgs('gh', 'local'), addArgs(next as any)]);
  });

  it('edit: 400 for a server it may not or cannot edit, 404 for an unknown one', async () => {
    const { app, cliCalls } = makeApp();
    const body = { name: 'x', scope: 'local', transport: 'stdio', command: 'x' };
    expect((await app.inject({ method: 'PUT', url: '/api/sessions/run/mcp/shared', payload: body })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/sessions/run/mcp/odd', payload: body })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/sessions/run/mcp/nope', payload: body })).statusCode).toBe(404);
    expect(cliCalls).toEqual([]);
  });

  it('remove runs claude mcp remove in the scope the server lives in', async () => {
    const { app, cliCalls } = makeApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/sessions/run/mcp/gh' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ servers: ROWS, restartNeeded: true });
    expect(cliCalls).toEqual([{ args: removeArgs('gh', 'local'), cwd: '/w/proj' }]);
    expect((await app.inject({ method: 'DELETE', url: '/api/sessions/run/mcp/shared' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/sessions/run/mcp/nope' })).statusCode).toBe(404);
  });
});

describe('MCP routes — restart', () => {
  it('stops the session and resumes it parked, on the row\'s model and permission mode', async () => {
    const { app, runner } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp/restart' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ servers: ROWS });
    expect(runner.stopAndWait).toHaveBeenCalledWith('run', undefined);
    expect(runner.start).toHaveBeenCalledWith({
      cwd: '/w/proj', prompt: '', permissionMode: 'plan', resume: 'run', model: 'opus',
    });
  });

  it('409 while a turn runs or a decision waits, and for a session not running', async () => {
    const { app, runner } = makeApp();
    runner.status.mockImplementation((id: string) => (id === 'run' ? 'working' : undefined));
    expect((await app.inject({ method: 'POST', url: '/api/sessions/run/mcp/restart' })).statusCode).toBe(409);
    runner.status.mockImplementation((id: string) => (id === 'run' ? 'needs_input' : undefined));
    runner.pendingDecision.mockReturnValue({ id: 'd1' });
    expect((await app.inject({ method: 'POST', url: '/api/sessions/run/mcp/restart' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/asleep/mcp/restart' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/nope/mcp/restart' })).statusCode).toBe(404);
    expect(runner.stopAndWait).not.toHaveBeenCalled();
  });

  it('504 when the process will not stop', async () => {
    const { app, runner } = makeApp();
    runner.stopAndWait.mockRejectedValueOnce(new Error('did not exit'));
    const res = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp/restart' });
    expect(res.statusCode).toBe(504);
    expect(runner.start).not.toHaveBeenCalled();
  });
});

describe('MCP routes — login', () => {
  const LOGIN_ROWS: McpServerRow[] = [
    { name: 'cf', status: 'needs-auth', origin: 'plugin', plugin: 'cloudflare', toggleable: true, editable: false },
    { name: 'claude.ai Gmail', status: 'needs-auth', origin: 'claudeai', toggleable: true, editable: false },
    { name: 'gh', status: 'connected', origin: 'local', toggleable: true, editable: true },
  ];

  it('starts the login of a server that needs one and answers its URL', async () => {
    const { app, runner } = makeApp();
    runner.mcpServers.mockResolvedValue(LOGIN_ROWS);
    runner.mcpLogin.mockResolvedValue({ authUrl: 'https://auth.example/authorize' });
    const res = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp/cf/login' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authUrl: 'https://auth.example/authorize' });
    expect(runner.mcpLogin).toHaveBeenCalledWith('run', 'cf');
  });

  it('400 for a server with no login to start, or a claude.ai connector; 404 for an unknown one', async () => {
    const { app, runner } = makeApp();
    runner.mcpServers.mockResolvedValue(LOGIN_ROWS);
    const connected = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp/gh/login' });
    expect([connected.statusCode, connected.json().error]).toEqual([400, 'not_loginable']);
    const claudeai = await app.inject({ method: 'POST', url: `/api/sessions/run/mcp/${encodeURIComponent('claude.ai Gmail')}/login` });
    expect([claudeai.statusCode, claudeai.json().error]).toEqual([400, 'not_loginable']);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/run/mcp/nope/login' })).statusCode).toBe(404);
    expect(runner.mcpLogin).not.toHaveBeenCalled();
  });

  it('502 login_unsupported when the CLI wants its callback relayed', async () => {
    const { app, runner } = makeApp();
    runner.mcpServers.mockResolvedValue(LOGIN_ROWS);
    runner.mcpLogin.mockRejectedValue(new McpLoginUnsupportedError('the login redirects to custom'));
    const res = await app.inject({ method: 'POST', url: '/api/sessions/run/mcp/cf/login' });
    expect([res.statusCode, res.json().error]).toEqual([502, 'login_unsupported']);
  });

  it('409 for a session not running here', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'POST', url: '/api/sessions/asleep/mcp/cf/login' })).statusCode).toBe(409);
  });
});
