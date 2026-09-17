import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { expandHome } from '../src/paths.js';

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
