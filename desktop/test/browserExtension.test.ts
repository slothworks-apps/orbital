import { describe, expect, it } from 'vitest';
import { browserExtensionDir } from '../src/lib/browserExtension';

describe('browserExtensionDir', () => {
  it('is the resources copy in the packaged app and the build output from the repository', () => {
    const where = { resourcesPath: '/Applications/Orbital.app/Contents/Resources', repoRoot: '/src/orbital' };
    expect(browserExtensionDir({ ...where, isPackaged: true })).toBe(
      '/Applications/Orbital.app/Contents/Resources/browser-extension',
    );
    expect(browserExtensionDir({ ...where, isPackaged: false })).toBe('/src/orbital/browser-extension/dist');
  });
});
