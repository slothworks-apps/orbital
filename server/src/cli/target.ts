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

/** The token, or null when the file is not there: the server mints it at its first start. */
export async function readToken(file: string): Promise<string | null> {
  try {
    const token = (await readFile(file, 'utf8')).trim();
    return token === '' ? null : token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
