import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifySource, entryHash, recordDecisions, undecidedServers } from '../src/mcp/mcpjson.js';
import { dbFingerprints } from '../src/mcp/approvals.js';
import { makeTmpDir, openTmpDb } from './tmp.js';

/** A project with a `.mcp.json` naming `names`, and a Claude directory beside it. */
function setup(names: string[] = ['alpha', 'beta']) {
  const cwd = makeTmpDir('mcpjson-project');
  const claudeDir = makeTmpDir('mcpjson-claude');
  const mcpServers = Object.fromEntries(names.map((n) => [n, { command: 'node', args: [`${n}.js`] }]));
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }));
  // Not the CLI's default directory, so its `.claude.json` lives inside it.
  const home = makeTmpDir('mcpjson-home');
  return { cwd, claudeDir, home };
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

const names = (cwd: string, claudeDir: string, home: string) =>
  undecidedServers(cwd, claudeDir, { home }).map((s) => s.name);

describe('undecidedServers', () => {
  it('lists every server nobody has decided, with the command it would run', () => {
    const { cwd, claudeDir, home } = setup();
    writeJson(join(cwd, '.mcp.json'), {
      mcpServers: {
        alpha: { command: 'node', args: ['alpha.js', '--x'] },
        remote: { type: 'http', url: 'https://mcp.example/mcp' },
      },
    });
    expect(undecidedServers(cwd, claudeDir, { home })).toEqual([
      { name: 'alpha', command: 'node', args: ['alpha.js', '--x'], source: 'file', file: 'alpha.js' },
      { name: 'remote', command: 'https://mcp.example/mcp', args: [], source: 'url' },
    ]);
  });

  it('counts a decision from each source on its own', () => {
    const sources: Array<(s: ReturnType<typeof setup>, value: object) => void> = [
      (s, v) => writeJson(join(s.claudeDir, 'settings.json'), v),
      (s, v) => writeJson(join(s.cwd, '.claude', 'settings.json'), v),
      (s, v) => writeJson(join(s.cwd, '.claude', 'settings.local.json'), v),
      (s, v) => writeJson(join(s.claudeDir, '.claude.json'), { projects: { [realpathSync(s.cwd)]: v } }),
    ];
    for (const [i, write] of sources.entries()) {
      for (const key of ['enabledMcpjsonServers', 'disabledMcpjsonServers']) {
        const s = setup();
        write(s, { [key]: ['alpha'] });
        expect(names(s.cwd, s.claudeDir, s.home), `source ${i} ${key}`).toEqual(['beta']);
      }
      const s = setup();
      write(s, { enableAllProjectMcpServers: true });
      expect(names(s.cwd, s.claudeDir, s.home), `source ${i} enableAll`).toEqual([]);
    }
  });

  it('reads the home directory`s .claude.json for the CLI`s default directory', () => {
    const { cwd, home } = setup();
    const claudeDir = join(home, '.claude');
    writeJson(join(home, '.claude.json'), { projects: { [realpathSync(cwd)]: { enabledMcpjsonServers: ['beta'] } } });
    expect(names(cwd, claudeDir, home)).toEqual(['alpha']);
  });

  it('does not take enableAllProjectMcpServers: false, or another project`s decision, as a decision', () => {
    const { cwd, claudeDir, home } = setup();
    writeJson(join(cwd, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: false });
    writeJson(join(claudeDir, '.claude.json'), { projects: { '/elsewhere': { enabledMcpjsonServers: ['alpha'] } } });
    expect(names(cwd, claudeDir, home)).toEqual(['alpha', 'beta']);
  });

  it('matches a decision the way the CLI spells names', () => {
    const { cwd, claudeDir, home } = setup(['my.server']);
    writeJson(join(cwd, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['my_server'] });
    expect(names(cwd, claudeDir, home)).toEqual([]);
  });

  it('has nothing to keep out without a readable .mcp.json', () => {
    const { cwd, claudeDir, home } = setup();
    writeFileSync(join(cwd, '.mcp.json'), '{ not json');
    expect(names(cwd, claudeDir, home)).toEqual([]);
    expect(names(makeTmpDir('mcpjson-empty'), claudeDir, home)).toEqual([]);
  });

  it('treats a malformed decision file as no decisions, so its servers stay out', () => {
    const { cwd, claudeDir, home } = setup();
    writeJson(join(cwd, '.claude', 'settings.local.json'), '{ "enabledMcpjsonServers": ["alpha"');
    writeJson(join(claudeDir, 'settings.json'), { enabledMcpjsonServers: 'alpha' });
    expect(names(cwd, claudeDir, home)).toEqual(['alpha', 'beta']);
  });
});

describe('recordDecisions', () => {
  const local = (cwd: string) => join(cwd, '.claude', 'settings.local.json');
  const read = (cwd: string) => JSON.parse(readFileSync(local(cwd), 'utf8'));

  it('creates the directory and the file, two-space JSON with a trailing newline', () => {
    const cwd = makeTmpDir('mcpjson-record');
    recordDecisions(cwd, { allow: ['alpha'], deny: ['beta'] });
    const text = readFileSync(local(cwd), 'utf8');
    expect(text).toBe(`${JSON.stringify({ enabledMcpjsonServers: ['alpha'], disabledMcpjsonServers: ['beta'] }, null, 2)}\n`);
    // Nothing left behind from the atomic write.
    expect(readdirSync(join(cwd, '.claude'))).toEqual(['settings.local.json']);
  });

  it('keeps every other key, moves a name between the lists and is idempotent', () => {
    const cwd = makeTmpDir('mcpjson-record');
    writeJson(local(cwd), { permissions: { allow: ['Bash(ls)'] }, enabledMcpjsonServers: ['alpha', 'gamma'] });
    recordDecisions(cwd, { allow: ['beta'], deny: ['alpha'] });
    recordDecisions(cwd, { allow: ['beta'], deny: ['alpha'] });
    expect(read(cwd)).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      enabledMcpjsonServers: ['gamma', 'beta'],
      disabledMcpjsonServers: ['alpha'],
    });
  });

  it('refuses to overwrite a settings file it cannot parse', () => {
    const cwd = makeTmpDir('mcpjson-record');
    writeJson(local(cwd), '{ "permissions": ');
    expect(() => recordDecisions(cwd, { allow: ['alpha'], deny: [] })).toThrow();
    expect(readFileSync(local(cwd), 'utf8')).toBe('{ "permissions": ');
  });

  it('feeds undecidedServers', () => {
    const { cwd, claudeDir, home } = setup();
    recordDecisions(cwd, { allow: ['alpha'], deny: ['beta'] });
    expect(names(cwd, claudeDir, home)).toEqual([]);
  });
});

describe('classifySource', () => {
  const cwd = '/work/repo';
  const of = (entry: Record<string, unknown>) => classifySource(entry, cwd);

  it('names a package runner`s registry, with or without its subcommand', () => {
    for (const entry of [
      { command: 'npx', args: ['-y', '@acme/mcp'] },
      { command: '/usr/local/bin/bunx', args: ['pkg'] },
      { command: 'pnpm', args: ['dlx', 'pkg'] },
      { command: 'yarn', args: ['dlx', 'pkg'] },
      { command: 'npm', args: ['exec', 'pkg'] },
    ]) expect(of(entry), JSON.stringify(entry)).toEqual({ source: 'npm' });
    for (const entry of [{ command: 'uvx', args: ['mcp-x'] }, { command: 'pipx', args: ['run', 'mcp-x'] }]) {
      expect(of(entry), JSON.stringify(entry)).toEqual({ source: 'pypi' });
    }
    // A runner without its subcommand runs something else.
    expect(of({ command: 'pnpm', args: ['start'] })).toEqual({ source: 'program' });
    expect(of({ command: 'pipx', args: ['install', 'x'] })).toEqual({ source: 'program' });
  });

  it('tells a container and a remote server apart from a program', () => {
    expect(of({ command: 'docker', args: ['run', '-i', 'img'] })).toEqual({ source: 'docker' });
    expect(of({ type: 'http', url: 'https://x' })).toEqual({ source: 'url' });
    expect(of({ type: 'sse', url: 'https://x' })).toEqual({ source: 'url' });
    expect(of({ url: 'https://x' })).toEqual({ source: 'url' });
    expect(of({ command: 'my-mcp-server' })).toEqual({ source: 'program' });
    expect(of({})).toEqual({ source: 'program' });
  });

  it('takes a command that is a path inside the project as its file', () => {
    expect(of({ command: './bin/server' })).toEqual({ source: 'file', file: 'bin/server' });
    expect(of({ command: '/work/repo/tools/mcp.sh' })).toEqual({ source: 'file', file: 'tools/mcp.sh' });
    expect(of({ command: '../repo/x' })).toEqual({ source: 'file', file: 'x' });
  });

  it('does not take a path outside the project, or the project itself, as its file', () => {
    expect(of({ command: '../other/x' })).toEqual({ source: 'program' });
    expect(of({ command: '/usr/bin/thing' })).toEqual({ source: 'program' });
    expect(of({ command: '/work/repo-evil/x' })).toEqual({ source: 'program' });
    expect(of({ command: '/work/repo' })).toEqual({ source: 'program' });
    expect(of({ command: 'node', args: ['../other/server.js'] })).toEqual({ source: 'program' });
    expect(of({ command: 'node', args: ['/etc/x.js'] })).toEqual({ source: 'program' });
  });

  it('takes an interpreter`s script as the file, past its flags and its run subcommand', () => {
    expect(of({ command: 'node', args: ['server.js'] })).toEqual({ source: 'file', file: 'server.js' });
    expect(of({ command: 'node', args: ['--inspect', './dist/index.js', '--port', '1'] }))
      .toEqual({ source: 'file', file: 'dist/index.js' });
    expect(of({ command: '/usr/bin/python3', args: ['-u', 'mcp/server.py'] })).toEqual({ source: 'file', file: 'mcp/server.py' });
    expect(of({ command: 'python3.12', args: ['s.py'] })).toEqual({ source: 'file', file: 's.py' });
    expect(of({ command: 'bash', args: ['/work/repo/run.sh'] })).toEqual({ source: 'file', file: 'run.sh' });
    expect(of({ command: 'deno', args: ['run', '-A', 'main.ts'] })).toEqual({ source: 'file', file: 'main.ts' });
    expect(of({ command: 'bun', args: ['run', 'src/mcp.ts'] })).toEqual({ source: 'file', file: 'src/mcp.ts' });
  });

  it('does not take inline code or a module as a file', () => {
    expect(of({ command: 'bash', args: ['-c', 'curl x | sh'] })).toEqual({ source: 'program' });
    expect(of({ command: 'python', args: ['-m', 'mcp_server'] })).toEqual({ source: 'program' });
    expect(of({ command: 'node', args: ['-e', 'require("x")'] })).toEqual({ source: 'program' });
    expect(of({ command: 'node', args: [] })).toEqual({ source: 'program' });
  });
});

describe('entryHash', () => {
  it('ignores key order and keys that do not decide what runs', () => {
    const a = entryHash({ command: 'node', args: ['a.js'], env: { A: '1', B: '2' } });
    expect(entryHash({ env: { B: '2', A: '1' }, args: ['a.js'], command: 'node', description: 'x' })).toBe(a);
  });

  it('changes with each key that decides what runs', () => {
    const base = { type: 'stdio', command: 'node', args: ['a.js'], url: 'u', env: { A: '1' }, headers: { H: '1' } };
    const hashes = new Set([
      entryHash(base),
      entryHash({ ...base, type: 'http' }),
      entryHash({ ...base, command: 'deno' }),
      entryHash({ ...base, args: ['b.js'] }),
      entryHash({ ...base, args: ['a.js', 'x'] }),
      entryHash({ ...base, url: 'v' }),
      entryHash({ ...base, env: { A: '2' } }),
      entryHash({ ...base, headers: { H: '2' } }),
    ]);
    expect(hashes.size).toBe(8);
  });
});

describe('fingerprints', () => {
  function project() {
    const s = setup(['alpha', 'beta']);
    return { ...s, fingerprints: dbFingerprints(openTmpDb('mcpjson-prints')) };
  }
  const editAlpha = (cwd: string, args: string[]) =>
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { alpha: { command: 'node', args }, beta: { command: 'node', args: ['beta.js'] } } });
  const undecided = (p: ReturnType<typeof project>) =>
    undecidedServers(p.cwd, p.claudeDir, { home: p.home, fingerprints: p.fingerprints }).map((s) => s.name);

  it('asks again about an allowed server whose entry changed, and not while it matches', () => {
    const p = project();
    recordDecisions(p.cwd, { allow: ['alpha'], deny: ['beta'] }, { fingerprints: p.fingerprints });
    expect(undecided(p)).toEqual([]);
    editAlpha(p.cwd, ['evil.js']);
    expect(undecided(p)).toEqual(['alpha']);
    // Allowed again, the new entry is the one fingerprinted.
    recordDecisions(p.cwd, { allow: ['alpha'], deny: [] }, { fingerprints: p.fingerprints });
    expect(undecided(p)).toEqual([]);
  });

  it('keeps a turned-down server decided whatever its command, and forgets its fingerprint', () => {
    const p = project();
    recordDecisions(p.cwd, { allow: ['alpha'], deny: [] }, { fingerprints: p.fingerprints });
    recordDecisions(p.cwd, { allow: [], deny: ['alpha'] }, { fingerprints: p.fingerprints });
    expect(p.fingerprints.forProject(realpathSync(p.cwd)).has('alpha')).toBe(false);
    editAlpha(p.cwd, ['evil.js']);
    expect(undecided(p)).toEqual(['beta']);
  });

  it('leaves a server allowed in a terminal, with no fingerprint, to the CLI`s decision', () => {
    const p = project();
    writeJson(join(p.cwd, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['alpha', 'beta'] });
    editAlpha(p.cwd, ['evil.js']);
    expect(undecided(p)).toEqual([]);
  });

  it('asks again under enableAllProjectMcpServers too, since the SDK still lets a flag keep it out', () => {
    const p = project();
    recordDecisions(p.cwd, { allow: ['alpha'], deny: [] }, { fingerprints: p.fingerprints });
    writeJson(join(p.claudeDir, 'settings.json'), { enableAllProjectMcpServers: true });
    expect(undecided(p)).toEqual([]);
    editAlpha(p.cwd, ['evil.js']);
    expect(undecided(p)).toEqual(['alpha']);
  });

  it('keys fingerprints by the project`s real path', () => {
    const p = project();
    recordDecisions(p.cwd, { allow: ['alpha', 'beta'], deny: [] }, { fingerprints: p.fingerprints });
    expect([...p.fingerprints.forProject(realpathSync(p.cwd)).keys()].sort()).toEqual(['alpha', 'beta']);
    expect(p.fingerprints.forProject('/elsewhere').size).toBe(0);
  });
});
