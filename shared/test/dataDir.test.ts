import { describe, expect, it } from 'vitest';
import { orbitalDataDir } from '../src/dataDir.js';

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
