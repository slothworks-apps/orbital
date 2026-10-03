import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The API token (spec 2026-10-03-api-token-and-named-files-design § 1). It
 * keeps browser pages that are not Orbital off `/api` and `/ws`; processes
 * running as the user can read the file anyway, and are outside the threat.
 */
export const API_TOKEN_FILE = 'api-token';
/** The web app's carrier, set by `GET /api/auth`. */
export const API_TOKEN_COOKIE = 'orbital_token';

/**
 * Reads `<dataDir>/API_TOKEN_FILE`, minting it on first start. It persists
 * across restarts — `tsx watch` restarts the dev server on every save, and a
 * token per start would log the browser out each time. Delete the file to
 * rotate it.
 */
export function loadOrCreateApiToken(dataDir: string): string {
  const file = join(dataDir, API_TOKEN_FILE);
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** The token as the cookie header carries it, or undefined. */
export function tokenFromCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== API_TOKEN_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/** The token as an `Authorization: Bearer` header carries it, or undefined. */
export function tokenFromBearer(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

/** Constant-time for equal lengths; a length mismatch is a plain refusal. */
export function tokenMatches(candidate: string | undefined, token: string): boolean {
  if (candidate === undefined) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Where `GET /api/auth` may send the browser: a same-origin path, or `/`.
 * `//host` and backslashes are what turn a path into another origin.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  try {
    const base = 'http://orbital.invalid';
    const url = new URL(next, base);
    // Dot segments can normalise `/.//host` into a `//host` path.
    if (url.origin !== base || url.pathname.startsWith('//')) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
