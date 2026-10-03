/**
 * The local API's token, as the main process carries it (spec
 * 2026-10-03-api-token-and-named-files-design § 1).
 *
 * The server mints it into its data dir on startup; the desktop reads the same
 * file, which is why forking our own server and attaching to `npm run dev`
 * need nothing different. Pure on purpose — `main.ts` does the reading and the
 * Electron calls.
 */
import { join } from 'node:path';
import { appOrigins } from './startup';

/** The file the server keeps the token in, inside its data dir. */
export const API_TOKEN_FILE = 'api-token';

/** The cookie a browser page carries the token in. */
export const AUTH_COOKIE = 'orbital_token';

/**
 * Where the token file is. The data dir resolves exactly as the server's
 * `config.ts` resolves it; the forked server inherits this process's
 * environment, so both read `ORBITAL_DATA_DIR` from the same place.
 */
export function apiTokenPath(env: { ORBITAL_DATA_DIR?: string }, home: string): string {
  const dataDir = env.ORBITAL_DATA_DIR ?? join(home, 'Library', 'Application Support', 'orbital');
  return join(dataDir, API_TOKEN_FILE);
}

/** The token from the file's text; null for a missing or blank file. */
export function parseApiToken(text: string | null): string | null {
  const token = text?.trim() ?? '';
  return token === '' ? null : token;
}

/**
 * The headers a main-process request carries. None without a token: an older
 * server has no guard, and a call without the header is what it expects.
 */
export function bearerHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type AuthCookie = {
  url: string;
  name: string;
  value: string;
  httpOnly: true;
  sameSite: 'strict';
  path: '/';
};

/**
 * The cookie for every origin an Orbital window loads, so no window has to go
 * through `/api/auth` first. A cookie belongs to a host, not a port, so the
 * origins collapse to one cookie per host — the server's and vite's
 * `127.0.0.1` share one, `localhost` gets its own.
 */
export function authCookies(token: string, port: number): AuthCookie[] {
  const byHost = new Map<string, string>();
  for (const origin of appOrigins(port)) {
    const host = new URL(origin).hostname;
    if (!byHost.has(host)) byHost.set(host, origin);
  }
  return [...byHost.values()].map((url) => ({
    url,
    name: AUTH_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  }));
}
