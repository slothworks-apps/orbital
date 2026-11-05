import { join } from 'node:path';

/**
 * Where the browser bridge's extension lies on disk (spec
 * 2026-11-05-browser-bridge-design § Installing it): in the app's resources
 * once packaged (electron-builder.yml's `extraResources`), in the
 * workspace's build output when run from the repository.
 */
export function browserExtensionDir(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  repoRoot: string;
}): string {
  return opts.isPackaged
    ? join(opts.resourcesPath, 'browser-extension')
    : join(opts.repoRoot, 'browser-extension', 'dist');
}
