import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordDecisions, undecidedServers } from '../src/mcp/mcpjson.js';
import { makeTmpDir } from './tmp.js';

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
      { name: 'alpha', command: 'node', args: ['alpha.js', '--x'] },
      { name: 'remote', command: 'https://mcp.example/mcp', args: [] },
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
