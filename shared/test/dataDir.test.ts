import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_DIR_MODE, DataDirNotOwned, ensureDataDir, orbitalDataDir } from '../src/dataDir.js';

describe('orbitalDataDir', () => {
  it('follows ORBITAL_DATA_DIR on any platform, over XDG_DATA_HOME too', () => {
    const env = { ORBITAL_DATA_DIR: '/srv/orbital', XDG_DATA_HOME: '/xdg' };
    expect(orbitalDataDir({ env, home: '/home/x', platform: 'linux' })).toBe('/srv/orbital');
    expect(orbitalDataDir({ env, home: '/Users/x', platform: 'darwin' })).toBe('/srv/orbital');
  });

  it('keeps Application Support on a Mac, whatever XDG_DATA_HOME says', () => {
    expect(orbitalDataDir({ env: { XDG_DATA_HOME: '/xdg' }, home: '/Users/x', platform: 'darwin' })).toBe(
      '/Users/x/Library/Application Support/orbital',
    );
  });

  it('uses an absolute XDG_DATA_HOME on Linux', () => {
    expect(orbitalDataDir({ env: { XDG_DATA_HOME: '/data/xdg' }, home: '/home/x', platform: 'linux' })).toBe(
      '/data/xdg/orbital',
    );
  });

  it('falls back to ~/.local/share without XDG_DATA_HOME, or with an empty or relative one', () => {
    for (const XDG_DATA_HOME of [undefined, '', 'relative/dir']) {
      expect(orbitalDataDir({ env: { XDG_DATA_HOME }, home: '/home/x', platform: 'linux' })).toBe(
        '/home/x/.local/share/orbital',
      );
    }
  });

  it('ignores an empty ORBITAL_DATA_DIR rather than writing to the working directory', () => {
    expect(orbitalDataDir({ env: { ORBITAL_DATA_DIR: '' }, home: '/home/x', platform: 'linux' })).toBe(
      '/home/x/.local/share/orbital',
    );
  });
});

describe('ensureDataDir', () => {
  const mode = (p: string) => statSync(p).mode & 0o777;
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orbital-datadir-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('makes a missing data dir, its parents too, for this user alone', () => {
    const dir = join(root, 'share', 'orbital');
    ensureDataDir(dir, 'linux');
    expect(mode(dir)).toBe(DATA_DIR_MODE);
  });

  it('takes group and other bits off an existing one, except on a Mac', () => {
    const dir = join(root, 'orbital');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    ensureDataDir(dir, 'darwin');
    expect(mode(dir)).toBe(0o755);
    ensureDataDir(dir, 'linux');
    expect(mode(dir)).toBe(DATA_DIR_MODE);
  });
});

describe('ensureDataDir: whose it is, and a filesystem without modes', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orbital-datadir-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('refuses a data dir another uid owns, before changing anything', () => {
    const dir = join(root, 'orbital');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const mine = statSync(dir).uid;
    expect(() => ensureDataDir(dir, 'linux', mine + 1)).toThrow(DataDirNotOwned);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(ensureDataDir(dir, 'linux', mine)).toBeNull();
  });
});
