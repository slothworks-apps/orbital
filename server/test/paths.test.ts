import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { expandHome, resolveClaudeDir } from '../src/paths.js';

const HOME = homedir();

describe('expandHome', () => {
  it('expands a bare ~ to the home directory', () => {
    expect(expandHome('~')).toBe(HOME);
  });

  it('expands ~/ prefixed paths', () => {
    expect(expandHome('~/Projects/slothworks/atlas')).toBe(`${HOME}/Projects/slothworks/atlas`);
  });

  it('leaves absolute paths untouched', () => {
    expect(expandHome('/Users/someone/work')).toBe('/Users/someone/work');
  });

  it('leaves a tilde that is not the whole first segment alone', () => {
    // `~alice` is another user's home, which only the shell can resolve, and
    // `a~b` is an ordinary directory name. Rewriting either would invent a
    // path the user never asked for.
    expect(expandHome('~alice/work')).toBe('~alice/work');
    expect(expandHome('/tmp/a~b')).toBe('/tmp/a~b');
  });

  it('trims surrounding whitespace, which a pasted path carries', () => {
    expect(expandHome('  ~/work  ')).toBe(`${HOME}/work`);
  });

  it('passes empty input straight through', () => {
    expect(expandHome('')).toBe('');
  });
});

describe('resolveClaudeDir', () => {
  const HOME_FIXTURE = '/Users/fixture';
  const resolve = (input: Parameters<typeof resolveClaudeDir>[0]) =>
    resolveClaudeDir({ home: HOME_FIXTURE, ...input });

  it('falls back to ~/.claude when nothing is configured', () => {
    expect(resolve({})).toBe('/Users/fixture/.claude');
    expect(resolve({ env: undefined, stored: undefined })).toBe('/Users/fixture/.claude');
  });

  it('uses the stored setting when there is no env var', () => {
    expect(resolve({ stored: '/srv/claude' })).toBe('/srv/claude');
  });

  /**
   * The precedence that matters: someone who exported a variable is telling
   * this process where to look right now, and must not be overruled by a row
   * clicked into the settings table months ago.
   */
  it('lets the env var outrank the stored setting', () => {
    expect(resolve({ env: '/env/claude', stored: '/stored/claude' })).toBe('/env/claude');
  });

  it('lets an explicit override outrank both — that is what tests pass', () => {
    expect(resolve({ override: '/o', env: '/e', stored: '/s' })).toBe('/o');
  });

  /**
   * An emptied text field stores '', and that has to read as "back to the
   * default" rather than "watch the process's working directory".
   */
  it('treats empty and whitespace-only as unset at every level', () => {
    expect(resolve({ stored: '' })).toBe('/Users/fixture/.claude');
    expect(resolve({ stored: '   ' })).toBe('/Users/fixture/.claude');
    expect(resolve({ env: '', stored: '/stored/claude' })).toBe('/stored/claude');
    expect(resolve({ env: '  ', stored: '/stored/claude' })).toBe('/stored/claude');
  });

  it('expands a typed ~, because nothing downstream is a shell', () => {
    expect(resolve({ stored: '~/.claude-work' })).toBe('/Users/fixture/.claude-work');
    expect(resolve({ env: '~' })).toBe('/Users/fixture');
  });
});
