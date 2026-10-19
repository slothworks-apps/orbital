/**
 * Where Orbital keeps its data — the database, the API token, the keys
 * (spec 2026-10-19-headless-server-design § The Linux fixes). The server, the
 * desktop and the `orbital` CLI each need the same answer, so it is written
 * once, here, and kept pure: the caller passes its environment, home and
 * platform. `ensureDataDir` is the one place that makes it.
 *
 * Node-only: nothing on the phone imports this.
 */
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type DataDirInput = {
  env: { ORBITAL_DATA_DIR?: string; XDG_DATA_HOME?: string };
  home: string;
  platform: NodeJS.Platform;
};

/**
 * `ORBITAL_DATA_DIR` when set; on a Mac, Application Support as it always
 * was; elsewhere the XDG data dir — `$XDG_DATA_HOME` only when it is an
 * absolute path, as the XDG spec says a relative one is to be ignored.
 */
export function orbitalDataDir({ env, home, platform }: DataDirInput): string {
  if (env.ORBITAL_DATA_DIR) return env.ORBITAL_DATA_DIR;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'orbital');
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share');
  return join(base, 'orbital');
}

/** The data dir's mode: the token, the keys and the database are this user's alone. */
export const DATA_DIR_MODE = 0o700;

/**
 * Makes the data dir with `DATA_DIR_MODE`, and, where it already exists
 * with any group or other bit set, takes those away — except on a Mac,
 * whose Application Support is the user's already and where the desktop app
 * is the threat model. Every creator of the data dir goes through this, so
 * none makes it readable to the machine's other users.
 */
export function ensureDataDir(dir: string, platform: NodeJS.Platform): void {
  mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE });
  if (platform === 'darwin') return;
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, DATA_DIR_MODE);
}
