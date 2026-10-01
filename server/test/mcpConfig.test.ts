import { describe, it, expect } from 'vitest';
import {
  McpCliMissingError,
  McpCliRefusedError,
  McpConfig,
  McpDefinitionError,
  addArgs,
  parseDefinition,
  removeArgs,
  type McpCliRun,
} from '../src/mcp/config.js';
import { claudeJsonPath, readMcpConfig, toDefinition } from '../src/mcp/claudeJson.js';
import { parsePluginName, shapeMcpServers } from '../src/mcp/rows.js';
import type { McpServerDefinition } from '../src/types.js';

const STDIO: McpServerDefinition = {
  name: 'gh', scope: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'],
  env: { GITHUB_TOKEN: 'ghp_secret123' },
};
const HTTP: McpServerDefinition = {
  name: 'linear', scope: 'user', transport: 'http', url: 'https://mcp.linear.app/mcp',
  headers: { Authorization: 'Bearer tok-abc' },
};

/** A CLI that records each call and answers from a script, in order. */
function fakeCli(answers: Array<{ ok: boolean; output: string }>) {
  const calls: Array<{ cliPath: string; args: string[]; cwd: string }> = [];
  const run: McpCliRun = async (cliPath, args, cwd) => {
    calls.push({ cliPath, args, cwd });
    return answers.shift() ?? { ok: true, output: '' };
  };
  return { run, calls };
}

function configWith(run: McpCliRun) {
  return new McpConfig({ cliPath: '/bin/claude', claudeJsonPath: '/fixture/.claude.json', run, readFile: () => '{}' });
}

describe('MCP config through the CLI', () => {
  it('builds add-json and remove arguments for each scope', () => {
    expect(addArgs(STDIO)).toEqual([
      'mcp', 'add-json', '--scope', 'local', 'gh',
      JSON.stringify({ type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: 'ghp_secret123' } }),
    ]);
    expect(addArgs(HTTP)).toEqual([
      'mcp', 'add-json', '--scope', 'user', 'linear',
      JSON.stringify({ type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer tok-abc' } }),
    ]);
    expect(removeArgs('gh', 'local')).toEqual(['mcp', 'remove', '--scope', 'local', 'gh']);
    expect(removeArgs('gh', 'user')).toEqual(['mcp', 'remove', '--scope', 'user', 'gh']);
  });

  it('runs in the session cwd', async () => {
    const cli = fakeCli([]);
    await configWith(cli.run).add('/w/proj', STDIO);
    expect(cli.calls).toEqual([{ cliPath: '/bin/claude', args: addArgs(STDIO), cwd: '/w/proj' }]);
  });

  it('refuses the project scope and malformed bodies', () => {
    const refusal = (body: unknown) => {
      try {
        parseDefinition(body);
      } catch (err) {
        return err instanceof McpDefinitionError ? err.code : 'other';
      }
      return null;
    };
    expect(refusal({ ...STDIO, scope: 'project' })).toBe('project_scope');
    expect(refusal({ ...STDIO, name: 'has space' })).toBe('invalid');
    expect(refusal({ ...STDIO, name: '--scope' })).toBe('invalid');
    expect(refusal({ ...STDIO, command: '' })).toBe('invalid');
    expect(refusal({ ...STDIO, args: 'one line' })).toBe('invalid');
    expect(refusal({ ...STDIO, env: { 'BAD KEY': 'x' } })).toBe('invalid');
    expect(refusal({ ...HTTP, url: 'ftp://x' })).toBe('invalid');
    expect(refusal({ ...HTTP, headers: { Auth: 1 } })).toBe('invalid');
    expect(refusal({ ...HTTP, transport: 'ws' })).toBe('invalid');
    expect(refusal(STDIO)).toBeNull();
    expect(refusal(HTTP)).toBeNull();
    // Nothing the body carries beyond the fields reaches the CLI's JSON.
    expect(parseDefinition({ ...HTTP, oauth: { clientId: 'x' } })).toEqual(HTTP);
  });

  it('a refusal carries the CLI output and a command with no secret in it', async () => {
    const cli = fakeCli([{ ok: false, output: 'Invalid config: {"GITHUB_TOKEN":"ghp_secret123"}' }]);
    const err = await configWith(cli.run).add('/w', STDIO).catch((e) => e);
    expect(err).toBeInstanceOf(McpCliRefusedError);
    expect(err.command).toContain('claude mcp add-json --scope local gh');
    expect(err.command).toContain('"GITHUB_TOKEN":"***"');
    expect(err.command).not.toContain('ghp_secret123');
    expect(err.output).not.toContain('ghp_secret123');

    const http = fakeCli([{ ok: false, output: 'no' }]);
    const httpErr = await configWith(http.run).add('/w', HTTP).catch((e) => e);
    expect(httpErr.command).not.toContain('tok-abc');
    expect(httpErr.command).toContain('"Authorization":"***"');
  });

  it('edit removes, then adds, and puts the old definition back when the add is refused', async () => {
    const next: McpServerDefinition = { ...STDIO, name: 'github', command: 'bad' };
    const cli = fakeCli([{ ok: true, output: '' }, { ok: false, output: 'refused' }, { ok: true, output: '' }]);
    const err = await configWith(cli.run).edit('/w', STDIO, next).catch((e) => e);
    expect(err).toBeInstanceOf(McpCliRefusedError);
    expect(err.output).toBe('refused');
    expect(cli.calls.map((c) => c.args)).toEqual([removeArgs('gh', 'local'), addArgs(next), addArgs(STDIO)]);
  });

  it('edit says so when the restore fails too', async () => {
    const cli = fakeCli([{ ok: true, output: '' }, { ok: false, output: 'refused' }, { ok: false, output: 'also' }]);
    const err = await configWith(cli.run).edit('/w', STDIO, HTTP).catch((e) => e);
    expect(err.output).toContain('refused');
    expect(err.output).toContain('Restoring the previous definition of gh failed as well: also');
  });

  it('edit stops at a refused remove, leaving the server as it was', async () => {
    const cli = fakeCli([{ ok: false, output: 'not found' }]);
    await expect(configWith(cli.run).edit('/w', STDIO, HTTP)).rejects.toBeInstanceOf(McpCliRefusedError);
    expect(cli.calls).toHaveLength(1);
  });

  it('a missing CLI writes nothing', async () => {
    const cli = fakeCli([]);
    const config = new McpConfig({ cliPath: null, claudeJsonPath: '/x', run: cli.run });
    expect(config.writable).toBe(false);
    await expect(config.add('/w', STDIO)).rejects.toBeInstanceOf(McpCliMissingError);
    expect(cli.calls).toEqual([]);
  });
});

describe('~/.claude.json reader', () => {
  const FILE = JSON.stringify({
    mcpServers: {
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer t' } },
      shared: { type: 'stdio', command: 'user-version' },
    },
    projects: {
      '/private/tmp/proj': {
        mcpServers: {
          gh: { command: 'npx', args: ['-y', 'gh-mcp'], env: { T: 'x' } },
          shared: { type: 'stdio', command: 'local-version', args: [], env: {} },
          oauthy: { type: 'http', url: 'https://x', oauth: { clientId: 'c' } },
          broken: { type: 'stdio', args: 'not a list', command: 'x' },
        },
      },
    },
  });
  const read = (file: string | Error, cwd = '/tmp/proj') =>
    readMcpConfig({
      path: '/fixture/.claude.json',
      cwd,
      readFile: () => { if (file instanceof Error) throw file; return file; },
      realpath: (p) => p.replace(/^\/tmp\//, '/private/tmp/'),
    });

  it('finds user servers at the top and local ones under the real path of the cwd', () => {
    const config = read(FILE);
    expect(config.find('linear')).toEqual({
      scope: 'user',
      definition: { name: 'linear', scope: 'user', transport: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer t' } },
    });
    expect(config.find('gh')).toEqual({
      scope: 'local',
      definition: { name: 'gh', scope: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { T: 'x' } },
    });
    expect(config.find('nope')).toBeUndefined();
  });

  it('local wins over user, as it does in the CLI', () => {
    expect(read(FILE).find('shared')?.scope).toBe('local');
    expect(read(FILE, '/elsewhere').find('shared')?.scope).toBe('user');
  });

  it('an entry it does not understand is found but has no definition', () => {
    expect(read(FILE).find('oauthy')).toEqual({ scope: 'local', definition: null });
    expect(read(FILE).find('broken')).toEqual({ scope: 'local', definition: null });
    expect(toDefinition('x', 'user', { type: 'ws', url: 'wss://x' })).toBeNull();
    expect(toDefinition('x', 'user', 'string')).toBeNull();
  });

  it('a missing or malformed file reads as no servers', () => {
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    expect(read(missing).find('linear')).toBeUndefined();
    expect(read('{"mcpServers": {').find('linear')).toBeUndefined();
    expect(read('[]').find('linear')).toBeUndefined();
    expect(read('{"mcpServers": [1], "projects": null}').find('0')).toBeUndefined();
  });

  it('follows CLAUDE_CONFIG_DIR like the CLI', () => {
    expect(claudeJsonPath({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u')).toBe('/cfg/.claude.json');
    expect(claudeJsonPath({}, '/home/u')).toBe('/home/u/.claude.json');
  });
});

describe('MCP rows', () => {
  it('parses plugin names, and only those', () => {
    expect(parsePluginName('plugin:cloudflare:cloudflare-api')).toEqual({ plugin: 'cloudflare', server: 'cloudflare-api' });
    expect(parsePluginName('plugin:p:a:b')).toEqual({ plugin: 'p', server: 'a:b' });
    expect(parsePluginName('plugin:cloudflare')).toBeNull();
    expect(parsePluginName('plugin::x')).toBeNull();
    expect(parsePluginName('plugin:x:')).toBeNull();
    expect(parsePluginName('myplugin:x:y')).toBeNull();
    expect(parsePluginName('plugins:x:y')).toBeNull();
  });

  const config = {
    find: (name: string) =>
      name === 'added' ? { scope: 'user' as const, definition: null }
      : name === 'gh' ? { scope: 'local' as const, definition: null }
      : name === 'shadow' ? { scope: 'user' as const, definition: null }
      : undefined,
  };

  it('takes editability and the origin of a dynamic server from the config', () => {
    const rows = shapeMcpServers([
      { name: 'added', status: 'connected', source: 'dynamic', tools: [{ name: 'a' }, { name: 'b' }] },
      { name: 'gh', status: 'failed', scope: 'local', error: 'spawn ENOENT' },
      { name: 'gone', status: 'connected', source: 'user', tools: [] },
      { name: 'shadow', status: 'pending', source: 'project' },
      { name: 'plugin:cf:api', status: 'needs-auth', source: 'plugin' },
      { name: 'orbital', status: 'connected', source: 'sdk', tools: [{ name: 'spawn_session' }] },
      { name: 'new', status: 'from-the-future' },
      { status: 'connected' },
    ], config);
    expect(rows).toEqual([
      { name: 'added', status: 'connected', origin: 'user', toolCount: 2, toggleable: true, editable: true },
      { name: 'gh', status: 'failed', error: 'spawn ENOENT', origin: 'local', toggleable: true, editable: true },
      // Removed from the config, still connected until the restart: nothing left to edit.
      { name: 'gone', status: 'connected', origin: 'user', toolCount: 0, toggleable: true, editable: false },
      // The SDK runs the project's, whatever the user config also holds under the name.
      { name: 'shadow', status: 'pending', origin: 'project', toggleable: true, editable: false },
      { name: 'plugin:cf:api', status: 'needs-auth', origin: 'plugin', plugin: 'cf', toggleable: true, editable: false },
      { name: 'orbital', status: 'connected', origin: 'built-in', toolCount: 1, toggleable: false, editable: false },
      { name: 'new', status: 'from-the-future', toggleable: true, editable: false },
    ]);
  });
});
