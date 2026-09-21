import { describe, it, expect } from 'vitest';
import { delimiter } from 'node:path';
import { mergePath, parseLoginShellPath } from '../src/env/loginPath.js';

/**
 * An app launched from Finder gets `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
 * else, so the server reconstructs the user's real PATH from their login shell
 * (spec 2026-09-16-electron-wrapper-design § 3). Both halves of that — reading
 * a PATH out of whatever a profile printed, and merging it over the current
 * one — are pure, and are the only parts worth pinning.
 */
describe('parseLoginShellPath', () => {
  it('reads the PATH from clean output', () => {
    expect(parseLoginShellPath('\n/opt/homebrew/bin:/usr/bin:/bin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin',
    );
  });

  it('takes the last PATH-looking line, past whatever the profile echoed first', () => {
    const stdout = ['Welcome back!', 'nvm: using node v22', '', '/opt/homebrew/bin:/usr/bin'].join(
      '\n',
    );
    expect(parseLoginShellPath(stdout)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('ignores trailing noise that is not a path', () => {
    expect(parseLoginShellPath('/usr/local/bin:/usr/bin\nhave a nice day\n')).toBe(
      '/usr/local/bin:/usr/bin',
    );
  });

  it('returns null for empty or path-less output', () => {
    expect(parseLoginShellPath('')).toBeNull();
    expect(parseLoginShellPath('   \n  \n')).toBeNull();
    expect(parseLoginShellPath('command not found: printf')).toBeNull();
  });
});

describe('mergePath', () => {
  const join_ = (...dirs: string[]) => dirs.join(delimiter);

  it('puts the login shell PATH first, then the fallbacks, then what was left of the current one', () => {
    expect(
      mergePath(join_('/usr/bin', '/bin'), join_('/opt/homebrew/bin', '/usr/bin'), [
        '/home/me/.local/bin',
      ]),
    ).toBe(join_('/opt/homebrew/bin', '/usr/bin', '/home/me/.local/bin', '/bin'));
  });

  it('keeps the current PATH as the base when the login shell said nothing', () => {
    expect(mergePath(join_('/usr/bin', '/bin'), null, ['/opt/homebrew/bin'])).toBe(
      join_('/usr/bin', '/bin', '/opt/homebrew/bin'),
    );
  });

  it('dedupes and drops empty segments', () => {
    expect(
      mergePath(join_('/usr/bin', '', '/bin'), join_('/usr/bin', '/usr/bin', ''), ['/bin']),
    ).toBe(join_('/usr/bin', '/bin'));
  });

  it('copes with no current PATH at all', () => {
    expect(mergePath(undefined, '/usr/bin', ['/opt/homebrew/bin'])).toBe(
      join_('/usr/bin', '/opt/homebrew/bin'),
    );
    expect(mergePath(undefined, null, ['/opt/homebrew/bin'])).toBe('/opt/homebrew/bin');
  });
});
