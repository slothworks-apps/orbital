/**
 * Where the `orbital` CLI finds the server it drives (spec
 * 2026-10-19-headless-server-design § The CLI): the port the server listens
 * on, and the API token file in the data dir. The same answers the server
 * itself reads, from the same environment.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { orbitalDataDir, type DataDirInput } from '@orbital/shared/dataDir';
import { API_TOKEN_FILE } from '../auth/token.js';
import { DEFAULT_PORT } from '../config.js';

export type CliTarget = { port: number; tokenFile: string };

/**
 * `ORBITAL_PORT` when set, else `DEFAULT_PORT`; the token under the data dir
 * `orbitalDataDir` names. A port that is no port is an error, not a guess.
 */
export function cliTarget(input: DataDirInput & { env: { ORBITAL_PORT?: string } }): CliTarget | { error: string } {
  const raw = input.env.ORBITAL_PORT;
  let port = DEFAULT_PORT;
  if (raw !== undefined && raw !== '') {
    const n = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
    if (!(n >= 1 && n <= 65535)) return { error: `ORBITAL_PORT is not a port: ${raw}` };
    port = n;
  }
  return { port, tokenFile: join(orbitalDataDir(input), API_TOKEN_FILE) };
}

/** The token; `missing` before the server's first start; `unreadable` when the file is another user's. */
export type TokenRead = { token: string } | { missing: true } | { unreadable: true };

export async function readToken(file: string): Promise<TokenRead> {
  try {
    const token = (await readFile(file, 'utf8')).trim();
    return token === '' ? { missing: true } : { token };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { missing: true };
    if (code === 'EACCES' || code === 'EPERM') return { unreadable: true };
    throw err;
  }
}

/**
 * The token file is another user's: name that user when the package
 * recorded one (`/etc/orbital/user`), as `rootHint` does.
 */
export function unreadableTokenLine(file: string, serviceUser: string | null): string {
  const user = serviceUser?.trim() ?? '';
  return USER_NAME.test(user)
    ? `Can't read ${file}: it belongs to another user. Orbital runs as ${user}: sudo -u ${user} orbital …`
    : `Can't read ${file}: it belongs to another user. Run orbital as the user Orbital runs as.`;
}

/** Where the package records the user the server runs as (`orbital setup`). */
export const SERVICE_USER_FILE = '/etc/orbital/user';

/** A user name as `/etc/orbital/user` may hold one; anything else is not shown. */
export const USER_NAME = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i;

/**
 * Said after "not running" when the CLI runs as root: the server runs as a
 * user, so root's data dir has no token and its port finds no server of its
 * own. Names that user when the package recorded one. Null for anyone else.
 */
export function rootHint(uid: number | null, serviceUser: string | null): string | null {
  if (uid !== 0) return null;
  const user = serviceUser?.trim() ?? '';
  return USER_NAME.test(user)
    ? `Orbital runs as ${user}, not root: sudo -u ${user} orbital …`
    : 'Orbital runs as a user, not root: run orbital as that user.';
}

/** The user `/etc/orbital/user` names, or null when there is no such file. */
export async function readServiceUser(file = SERVICE_USER_FILE): Promise<string | null> {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}
