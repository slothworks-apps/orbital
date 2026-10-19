import { describe, it, expect } from 'vitest';
import { userShell, verifyShell } from '../src/env/shell.js';

/**
 * Which shell runs a verify command, a terminal and the login-PATH lookup
 * (spec 2026-10-19-headless-server-design § The Linux fixes). The filesystem
 * is injected; only the choice is under test.
 */
const executable = (...present: string[]) => (p: string) => present.includes(p);

describe('userShell', () => {
  it('uses $SHELL when it names an executable by absolute path', () => {
    expect(userShell({ SHELL: '/usr/bin/fish' }, 'linux', executable('/usr/bin/fish'))).toBe('/usr/bin/fish');
    expect(userShell({ SHELL: '/bin/zsh' }, 'darwin', executable('/bin/zsh'))).toBe('/bin/zsh');
  });

  it('falls back to /bin/sh on Linux when $SHELL is unset, relative or not executable', () => {
    for (const SHELL of [undefined, '', 'zsh', '/bin/zsh']) {
      expect(userShell({ SHELL }, 'linux', executable())).toBe('/bin/sh');
    }
  });

  it('keeps zsh as the Mac fallback', () => {
    expect(userShell({}, 'darwin', executable())).toBe('/bin/zsh');
  });
});

describe('verifyShell', () => {
  it('keeps zsh on a Mac, whatever $SHELL is', () => {
    expect(verifyShell({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin', executable('/opt/homebrew/bin/fish'))).toBe('/bin/zsh');
  });

  it('uses $SHELL elsewhere when it is a POSIX shell', () => {
    for (const shell of ['/bin/bash', '/usr/bin/zsh', '/bin/dash', '/bin/sh', '/usr/bin/ksh']) {
      expect(verifyShell({ SHELL: shell }, 'linux', executable(shell))).toBe(shell);
    }
  });

  it('falls back to /bin/sh for any other shell, or none', () => {
    expect(verifyShell({ SHELL: '/usr/bin/fish' }, 'linux', executable('/usr/bin/fish'))).toBe('/bin/sh');
    expect(verifyShell({ SHELL: '/usr/bin/nu' }, 'linux', executable('/usr/bin/nu'))).toBe('/bin/sh');
    expect(verifyShell({}, 'linux', executable())).toBe('/bin/sh');
  });
});
