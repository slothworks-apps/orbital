import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * A login shell runs the user's whole profile, and nvm-style profiles are
 * slow. Past this the fallbacks alone have to do — a server that boots late
 * is worse than one that boots without `/opt/homebrew/bin`.
 */
export const LOGIN_SHELL_TIMEOUT_MS = 3000;

/** Where claude and friends commonly live when the login shell can't tell us. */
export function fallbackPathDirs(home: string = homedir()): string[] {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
  ];
}

/**
 * The PATH a login shell printed. Profiles echo noise before our printf, so
 * take the LAST non-empty line that looks like a PATH (contains a '/').
 */
export function parseLoginShellPath(stdout: string): string | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line && line.includes('/')) return line;
  }
  return null;
}

/**
 * Merge order: login-shell PATH first (or current when the shell failed),
 * then the fallback dirs, then whatever was in current that's not already
 * present. Dedupe, drop empties, join with `delimiter`.
 */
export function mergePath(
  current: string | undefined,
  loginPath: string | null,
  fallbacks: string[],
): string {
  const currentDirs = (current ?? '').split(delimiter);
  const base = loginPath === null ? currentDirs : loginPath.split(delimiter);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...base, ...fallbacks, ...currentDirs]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  return merged.join(delimiter);
}

/** execFile($SHELL, ['-l', '-c', 'printf "\n%s" "$PATH"'], { timeout }) → parsed or null on any failure. */
export function resolveLoginShellPath(
  shell: string = process.env.SHELL || '/bin/zsh',
  timeoutMs: number = LOGIN_SHELL_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-l', '-c', 'printf "\n%s" "$PATH"'],
      { timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseLoginShellPath(stdout));
      },
    );
  });
}

/**
 * The one entry point: no-op unless env.ORBITAL_RESOLVE_PATH === '1'.
 *
 * Only a GUI launch needs this, and it costs a login-shell spawn, so the
 * Electron main process opts in when it forks the server; a dev server or a
 * test already inherited a real PATH.
 */
export async function applyLoginShellPath(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.ORBITAL_RESOLVE_PATH !== '1') return;
  const loginPath = await resolveLoginShellPath();
  env.PATH = mergePath(env.PATH, loginPath, fallbackPathDirs());
}
