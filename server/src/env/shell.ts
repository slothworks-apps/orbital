import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * True when `p` is a regular file this process may execute. Existence alone is
 * not enough: a directory, or a file without the executable bit, would resolve
 * and fail only when something spawns it.
 */
export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The shell Orbital runs the user's commands in — a verify command, a
 * terminal, the login-shell PATH lookup (spec 2026-10-19-headless-server-design
 * § The Linux fixes). `$SHELL` when it names an executable by absolute path;
 * otherwise zsh on a Mac, as it always was, and `/bin/sh` elsewhere, where
 * zsh is often not installed.
 */
export function userShell(
  env: { SHELL?: string } = process.env,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (p: string) => boolean = isExecutableFile,
): string {
  const shell = env.SHELL;
  if (shell && isAbsolute(shell) && isExecutable(shell)) return shell;
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}
