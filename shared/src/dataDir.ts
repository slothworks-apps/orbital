/**
 * Where Orbital keeps its data — the database, the API token, the keys
 * (spec 2026-10-19-headless-server-design § The Linux fixes). The server, the
 * desktop and the `orbital` CLI each need the same answer, so it is written
 * once, here, and kept pure: the caller passes its environment, home and
 * platform.
 *
 * Node-only: nothing on the phone imports this.
 */
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
