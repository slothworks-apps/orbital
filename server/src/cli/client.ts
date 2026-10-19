/**
 * The CLI's one way to the server: the routes the web UI uses, over
 * `http://127.0.0.1:<port>` with the API token as a bearer (spec
 * 2026-10-19-headless-server-design § The CLI). `main` makes a call only
 * once the listener on the port is known to be this user's (`listener.ts`).
 */

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A route's answer: its status and its JSON body (null for none). */
export type Reply = { status: number; body: unknown };

export type Call = (method: Method, path: string, body?: unknown) => Promise<Reply>;

/** Nothing listens on the port. */
export class NotRunning extends Error {}

/** The server answered 401: the token file is not this server's. */
export class TokenRefused extends Error {}

/** A failure already worded for the user; the CLI prints it and exits 1. */
export class CliError extends Error {}

/**
 * Longer than any route the CLI asks waits: leaving the group waits for a
 * member's acknowledgement before it answers.
 */
const CALL_TIMEOUT_MS = 60_000;

export function httpCall(port: number, token: string, fetchFn: typeof fetch = fetch): Call {
  return async (method, path, body) => {
    let res: Response;
    try {
      res = await fetchFn(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw new CliError('Orbital did not answer in time.');
      throw new NotRunning();
    }
    if (res.status === 401) throw new TokenRefused();
    const text = await res.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, body: parsed };
  };
}

/** The `error` a refusal carries, or null. */
export function errorOf(reply: Reply): string | null {
  const b = reply.body;
  return typeof b === 'object' && b !== null && typeof (b as { error?: unknown }).error === 'string'
    ? (b as { error: string }).error
    : null;
}
