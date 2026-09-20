import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectCommands, parseFrontmatter } from '../src/commands/catalog.js';

/**
 * Fake `~/.claude` + project roots per test. Everything the scan reads is a
 * real file, because the shapes it has to honour (a folded `description:`, a
 * command with no frontmatter at all, the `skills/synced/<uuid>/<skill>`
 * nesting) are exactly what a mocked `fs` would let us get wrong.
 */
const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `orbital-${prefix}-`));
  cleanups.push(dir);
  return dir;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** A SKILL.md the way the real ones are written: fenced frontmatter first. */
function skill(root: string, ...segments: string[]): void {
  const name = segments[segments.length - 1];
  write(
    join(root, 'skills', ...segments, 'SKILL.md'),
    `---\nname: ${name}\ndescription: what ${name} does\n---\n\nbody\n`,
  );
}

describe('parseFrontmatter', () => {
  it('reads plain scalars from a fenced block', () => {
    expect(parseFrontmatter('---\nname: x\ndescription: does x\n---\nbody')).toMatchObject({
      name: 'x', description: 'does x',
    });
  });

  it('joins a folded block scalar into one line', () => {
    const text = [
      '---',
      'name: gh-stack',
      'description: >',
      '  Manage stacked branches and pull requests.',
      '  Use when the user wants to create or push a stack.',
      'metadata:',
      '  author: github',
      '---',
      'body',
    ].join('\n');
    expect(parseFrontmatter(text).description).toBe(
      'Manage stacked branches and pull requests. Use when the user wants to create or push a stack.',
    );
    // A nested key is not a top-level one.
    expect(parseFrontmatter(text).author).toBeUndefined();
  });

  it('strips matching quotes', () => {
    expect(parseFrontmatter('---\ndescription: "quoted"\n---').description).toBe('quoted');
    expect(parseFrontmatter("---\ndescription: 'quoted'\n---").description).toBe('quoted');
  });

  it('is empty for a file with no frontmatter at all', () => {
    expect(parseFrontmatter('The user is asking a question.\n')).toEqual({});
  });
});

describe('collectCommands', () => {
  it('reads user commands flat, with an empty description when there is no frontmatter', () => {
    const claudeDir = makeRoot('claude');
    write(join(claudeDir, 'commands', 'ask.md'), 'The user is asking a question.\n');
    write(
      join(claudeDir, 'commands', 'ship.md'),
      '---\ndescription: ship it\nallowed-tools: Bash(git push:*)\n---\nbody\n',
    );

    expect(collectCommands({ claudeDir, cwd: makeRoot('cwd') })).toEqual([
      { name: 'ask', description: '', source: 'user' },
      { name: 'ship', description: 'ship it', source: 'user' },
    ]);
  });

  it('names a user skill after its directory and describes it from SKILL.md', () => {
    const claudeDir = makeRoot('claude');
    skill(claudeDir, 'find-skills');

    expect(collectCommands({ claudeDir, cwd: makeRoot('cwd') })).toEqual([
      { name: 'find-skills', description: 'what find-skills does', source: 'user' },
    ]);
  });

  it('descends the skills/synced/<uuid>/<skill> level and never lists `synced` itself', () => {
    const claudeDir = makeRoot('claude');
    skill(claudeDir, 'synced', 'a1b2-uuid', 'morning');
    skill(claudeDir, 'synced', 'a1b2-uuid', 'pdf');

    const names = collectCommands({ claudeDir, cwd: makeRoot('cwd') }).map((c) => c.name);
    expect(names).toEqual(['morning', 'pdf']);
    expect(names).not.toContain('synced');
    expect(names).not.toContain('a1b2-uuid');
  });

  it('reads the project .claude under cwd and marks it `project`', () => {
    const claudeDir = makeRoot('claude');
    const cwd = makeRoot('cwd');
    write(join(cwd, '.claude', 'commands', 'deploy.md'), '---\ndescription: deploy\n---\n');
    skill(join(cwd, '.claude'), 'house-style');

    expect(collectCommands({ claudeDir, cwd })).toEqual([
      { name: 'deploy', description: 'deploy', source: 'project' },
      { name: 'house-style', description: 'what house-style does', source: 'project' },
    ]);
  });

  it('a project command outranks a user one of the same name', () => {
    const claudeDir = makeRoot('claude');
    const cwd = makeRoot('cwd');
    write(join(claudeDir, 'commands', 'review.md'), '---\ndescription: mine\n---\n');
    write(join(cwd, '.claude', 'commands', 'review.md'), '---\ndescription: ours\n---\n');

    expect(collectCommands({ claudeDir, cwd })).toEqual([
      { name: 'review', description: 'ours', source: 'project' },
    ]);
  });

  describe('plugins', () => {
    /** Writes the two files that together decide which plugins are live. */
    function installPlugins(
      claudeDir: string,
      installs: Record<string, string>,
      enabled: Record<string, boolean>,
    ): void {
      write(
        join(claudeDir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: Object.fromEntries(
            Object.entries(installs).map(([key, installPath]) => [
              key,
              [{ scope: 'user', installPath, version: 'abc123' }],
            ]),
          ),
        }),
      );
      write(join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: enabled }));
    }

    it('lists skills and commands from an enabled plugin as plugin:entry', () => {
      const claudeDir = makeRoot('claude');
      const installPath = join(claudeDir, 'plugins', 'cache', 'official', 'superpowers', 'v1');
      skill(installPath, 'brainstorming');
      write(join(installPath, 'commands', 'plan.md'), '---\ndescription: write a plan\n---\n');
      installPlugins(
        claudeDir,
        { 'superpowers@official': installPath },
        { 'superpowers@official': true },
      );

      expect(collectCommands({ claudeDir, cwd: makeRoot('cwd') })).toEqual([
        {
          name: 'superpowers:brainstorming',
          description: 'what brainstorming does',
          source: 'plugin:superpowers',
        },
        { name: 'superpowers:plan', description: 'write a plan', source: 'plugin:superpowers' },
      ]);
    });

    it('ignores a plugin that is installed but not enabled', () => {
      const claudeDir = makeRoot('claude');
      const installPath = join(claudeDir, 'plugins', 'cache', 'official', 'firebase', 'v1');
      write(join(installPath, 'commands', 'deploy.md'), '---\ndescription: deploy\n---\n');
      installPlugins(claudeDir, { 'firebase@official': installPath }, { 'firebase@official': false });

      expect(collectCommands({ claudeDir, cwd: makeRoot('cwd') })).toEqual([]);
    });

    it('ignores an enabled plugin that is not installed', () => {
      const claudeDir = makeRoot('claude');
      installPlugins(claudeDir, {}, { 'ghost@official': true });

      expect(collectCommands({ claudeDir, cwd: makeRoot('cwd') })).toEqual([]);
    });
  });

  it('excludes the agents namespace', () => {
    const claudeDir = makeRoot('claude');
    write(join(claudeDir, 'agents', 'reviewer.md'), '---\ndescription: reviews\n---\n');

    expect(collectCommands({ claudeDir, cwd: makeRoot('cwd') })).toEqual([]);
  });

  it('ignores non-markdown files and a skills directory with no SKILL.md', () => {
    const claudeDir = makeRoot('claude');
    write(join(claudeDir, 'commands', 'notes.txt'), 'not a command');
    write(join(claudeDir, 'skills', 'half-written', 'README.md'), 'no SKILL.md here');

    expect(collectCommands({ claudeDir, cwd: makeRoot('cwd') })).toEqual([]);
  });

  it('sorts by name across every source', () => {
    const claudeDir = makeRoot('claude');
    const cwd = makeRoot('cwd');
    write(join(claudeDir, 'commands', 'zebra.md'), '');
    skill(claudeDir, 'apple');
    write(join(cwd, '.claude', 'commands', 'mango.md'), '');

    expect(collectCommands({ claudeDir, cwd }).map((c) => c.name)).toEqual([
      'apple', 'mango', 'zebra',
    ]);
  });

  it('never throws when nothing exists — missing roots are the ordinary case', () => {
    expect(collectCommands({ claudeDir: '/nonexistent-claude', cwd: '/nonexistent-cwd' })).toEqual([]);
    expect(collectCommands({ claudeDir: '/nonexistent-claude', cwd: '' })).toEqual([]);
  });

  it('survives a corrupt installed_plugins.json or settings.json', () => {
    const claudeDir = makeRoot('claude');
    write(join(claudeDir, 'commands', 'ok.md'), '');
    write(join(claudeDir, 'plugins', 'installed_plugins.json'), '{ not json');
    write(join(claudeDir, 'settings.json'), 'also not json');

    expect(collectCommands({ claudeDir, cwd: makeRoot('cwd') })).toEqual([
      { name: 'ok', description: '', source: 'user' },
    ]);
  });
});
