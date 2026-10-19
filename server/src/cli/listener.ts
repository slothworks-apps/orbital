/**
 * Whose process listens on the port the CLI is about to send the token to.
 * On a server several users share, another user can bind the port while
 * Orbital is down; the CLI must not hand that process this user's token. On
 * Linux the kernel's socket tables (`/proc/net/tcp`, `/proc/net/tcp6`) say
 * which uid owns each listening socket. A Mac has no `/proc`, and there the
 * desktop app, on a machine with one user, is the threat model: the CLI
 * sends the token as it always did. Every other system is checked as Linux
 * is, and one whose tables cannot be read, or list nothing, gets no token.
 */
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';

/** `st` of a socket in LISTEN, as the tables print it. */
const LISTEN = '0A';

/**
 * The local addresses a connection to `127.0.0.1` can land on, as the tables
 * print them (host byte order, so both byte orders are taken): 127.0.0.1 and
 * 0.0.0.0 in `tcp`; `::` (dual-stack) and `::ffff:127.0.0.1` in `tcp6`.
 */
const REACHED = new Set([
  '0100007F', '7F000001', '00000000',
  '00000000000000000000000000000000',
  '0000000000000000FFFF00000100007F', '00000000000000000000FFFF7F000001',
]);

/**
 * The uids of the sockets listening on `port` at an address a connection to
 * `127.0.0.1:<port>` reaches, from one table's text. Lines that do not parse
 * are skipped.
 */
export function listenerUids(table: string, port: number): number[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  const uids: number[] = [];
  for (const line of table.split('\n')) {
    const cols = line.trim().split(/\s+/);
    // sl, local_address, rem_address, st, tx:rx, tr:when, retrnsmt, uid, ...
    if (cols.length < 8 || !/^\d+:$/.test(cols[0])) continue;
    const [address, localPort] = cols[1].toUpperCase().split(':');
    if (localPort !== hexPort || cols[3].toUpperCase() !== LISTEN || !REACHED.has(address)) continue;
    const uid = Number(cols[7]);
    if (Number.isInteger(uid) && uid >= 0) uids.push(uid);
  }
  return uids;
}

/** How many sockets of any port a table lists as listening. */
function listening(table: string): number {
  let n = 0;
  for (const line of table.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 8 && /^\d+:$/.test(cols[0]) && cols[3].toUpperCase() === LISTEN) n++;
  }
  return n;
}

/**
 * Who holds the port: `own` when every listener reachable at 127.0.0.1 is
 * this user's, `none` when nothing listens on it, `other` with the first
 * foreign uid, `unknown` when the tables could not be read, `unverifiable`
 * when they read but list no listening socket at all — a system (WSL1,
 * gVisor) whose tables do not show its sockets, where `none` would be a lie.
 */
export type ListenerOwner =
  | { kind: 'own' } | { kind: 'none' } | { kind: 'other'; uid: number } | { kind: 'unknown' } | { kind: 'unverifiable' };

export function listenerOwner(tables: readonly string[], port: number, uid: number): ListenerOwner {
  if (tables.every((t) => listening(t) === 0)) return { kind: 'unverifiable' };
  const uids = tables.flatMap((t) => listenerUids(t, port));
  if (uids.length === 0) return { kind: 'none' };
  const other = uids.find((u) => u !== uid);
  return other === undefined ? { kind: 'own' } : { kind: 'other', uid: other };
}

const TABLES = ['/proc/net/tcp', '/proc/net/tcp6'];

/**
 * The owner of `port` on this machine; always `own` on a Mac, which the CLI
 * does not check (see above). Anywhere else `tcp6` may be missing (IPv6
 * off); `tcp` may not, nor a uid for this process. Tables that list no
 * listener at all are asked no further, but the port is: a connection
 * refused is plainly `none` (Orbital is not running), one taken is
 * `unverifiable` — someone listens, and who cannot be told.
 */
export async function checkListener(
  port: number,
  o: {
    platform?: NodeJS.Platform;
    uid?: number;
    read?: (path: string) => Promise<string>;
    connects?: (port: number) => Promise<boolean>;
  } = {},
): Promise<ListenerOwner> {
  const platform = o.platform ?? process.platform;
  const uid = o.uid ?? process.getuid?.();
  if (platform === 'darwin') return { kind: 'own' };
  if (uid === undefined) return { kind: 'unknown' };
  const read = o.read ?? ((path: string) => readFile(path, 'utf8'));
  let v4: string;
  try {
    v4 = await read(TABLES[0]);
  } catch {
    return { kind: 'unknown' };
  }
  const v6 = await read(TABLES[1]).catch(() => '');
  const owner = listenerOwner([v4, v6], port, uid);
  if (owner.kind !== 'unverifiable') return owner;
  return (await (o.connects ?? portTakesConnection)(port)) ? owner : { kind: 'none' };
}

/** How long the token-free connect may take before it counts as taken: something may be there. */
const CONNECT_PROBE_MS = 2_000;

/**
 * Whether something accepts a TCP connection on `127.0.0.1:<port>`. Nothing
 * is sent: the socket closes as soon as it opens. Refused (or any error) is
 * false; a connect that neither opens nor fails in time is true.
 */
export function portTakesConnection(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (taken: boolean) => {
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(CONNECT_PROBE_MS, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Why the token was not sent, for an owner that is neither this user's nor nobody. */
export function listenerRefusalLine(port: number, owner: Exclude<ListenerOwner, { kind: 'own' | 'none' }>): string {
  switch (owner.kind) {
    case 'other':
      return `Another user's process (uid ${owner.uid}) is listening on port ${port}, not your Orbital. The token was not sent.`;
    case 'unknown':
      return `Could not tell whose process listens on port ${port} (${TABLES[0]} unreadable). The token was not sent.`;
    case 'unverifiable':
      return `Can't verify who listens on port ${port} on this system. The token was not sent.`;
  }
}
