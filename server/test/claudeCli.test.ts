import { describe, it, expect } from 'vitest';
import { delimiter, join } from 'node:path';
import {
  findClaudeOnDisk,
  parseClaudeVersionOutput,
  resolveClaudeCli,
} from '../src/runner/claudeCli.js';

/**
 * The packaged app does not ship the SDK's 201 MB CLI binary and must spawn
 * the user's own `claude` (spec 2026-09-16-electron-wrapper-design § 3). Which
 * one it picks, and what it calls that choice, is what the missing-CLI dialog
 * and the Settings panel both read — so the decision is pure and injectable,
 * and the filesystem never enters these tests.
 */
const HOME = '/Users/someone';

function existsIn(...present: string[]) {
  const set = new Set(present);
  return (p: string) => set.has(p);
}

describe('findClaudeOnDisk', () => {
  it('returns the first PATH directory holding a claude, in PATH order', () => {
    const found = findClaudeOnDisk({
      pathVar: ['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'].join(delimiter),
      home: HOME,
      exists: existsIn('/opt/homebrew/bin/claude', '/usr/local/bin/claude'),
    });
    expect(found).toBe('/opt/homebrew/bin/claude');
  });

  it('skips empty PATH segments', () => {
    const found = findClaudeOnDisk({
      pathVar: `${delimiter}/usr/bin${delimiter}${delimiter}/usr/local/bin${delimiter}`,
      home: HOME,
      exists: existsIn('/usr/local/bin/claude', 'claude'),
    });
    expect(found).toBe('/usr/local/bin/claude');
  });

  it('falls back to the known install locations when PATH has nothing', () => {
    const found = findClaudeOnDisk({
      pathVar: '/usr/bin:/bin',
      home: HOME,
      exists: existsIn(join(HOME, '.local', 'bin', 'claude')),
    });
    expect(found).toBe(join(HOME, '.local', 'bin', 'claude'));
  });

  it('copes with no PATH at all', () => {
    expect(
      findClaudeOnDisk({ pathVar: undefined, home: HOME, exists: () => false }),
    ).toBeNull();
  });
});

describe('resolveClaudeCli', () => {
  const base = { pathVar: '/usr/bin', home: HOME, exists: existsIn('/opt/homebrew/bin/claude') };

  it('lets a settings override win', () => {
    expect(
      resolveClaudeCli({ ...base, override: '/custom/claude', bundled: true, exists: existsIn('/custom/claude') }),
    ).toEqual({ path: '/custom/claude', source: 'settings' });
  });

  it('reports an override that is not on disk as missing rather than falling through', () => {
    expect(
      resolveClaudeCli({ ...base, override: '/custom/claude', bundled: true }),
    ).toEqual({ path: null, source: 'missing' });
  });

  it('prefers the SDK bundled binary in dev, leaving the path to the SDK', () => {
    expect(resolveClaudeCli({ ...base, override: '', bundled: true })).toEqual({
      path: null,
      source: 'bundled',
    });
  });

  it('searches PATH when the bundled binary is absent', () => {
    expect(
      resolveClaudeCli({
        override: '',
        bundled: false,
        pathVar: ['/usr/bin', '/opt/homebrew/bin'].join(delimiter),
        home: HOME,
        exists: existsIn('/opt/homebrew/bin/claude'),
      }),
    ).toEqual({ path: '/opt/homebrew/bin/claude', source: 'path' });
  });

  it('finds a claude in a known install location that is not on PATH', () => {
    expect(
      resolveClaudeCli({
        override: '',
        bundled: false,
        pathVar: '/usr/bin:/bin',
        home: HOME,
        exists: existsIn(join(HOME, '.claude', 'local', 'claude')),
      }),
    ).toEqual({ path: join(HOME, '.claude', 'local', 'claude'), source: 'path' });
  });

  it('reports missing when nothing is bundled and nothing is on disk', () => {
    expect(
      resolveClaudeCli({
        override: '',
        bundled: false,
        pathVar: '/usr/bin',
        home: HOME,
        exists: () => false,
      }),
    ).toEqual({ path: null, source: 'missing' });
  });
});

describe('parseClaudeVersionOutput', () => {
  it('reads the version out of what `claude --version` really prints', () => {
    expect(parseClaudeVersionOutput('2.1.236 (Claude Code)\n')).toBe('2.1.236');
  });

  it('accepts a bare version', () => {
    expect(parseClaudeVersionOutput('1.2.3')).toBe('1.2.3');
  });

  it('returns null when there is no version to read', () => {
    expect(parseClaudeVersionOutput('command not found')).toBeNull();
    expect(parseClaudeVersionOutput('')).toBeNull();
  });
});
