/**
 * Whose process listens on the port the CLI is about to send the token to.
 * On a server several users share, another user can bind the port while
 * Orbital is down; the CLI must not hand that process this user's token. On
 * Linux the kernel's socket tables (`/proc/net/tcp`, `/proc/net/tcp6`) say
 * which uid owns each listening socket. A Mac has no `/proc`, and there the
 * desktop app, on a machine with one user, is the threat model: the CLI
 * sends the token as it always did.
 */
import { readFile } from 'node:fs/promises';

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

/**
 * Who holds the port: `own` when every listener reachable at 127.0.0.1 is
 * this user's, `none` when nothing listens, `other` with the first foreign
 * uid, `unknown` when the tables could not be read.
 */
export type ListenerOwner = { kind: 'own' } | { kind: 'none' } | { kind: 'other'; uid: number } | { kind: 'unknown' };

export function listenerOwner(tables: readonly string[], port: number, uid: number): ListenerOwner {
  const uids = tables.flatMap((t) => listenerUids(t, port));
  if (uids.length === 0) return { kind: 'none' };
  const other = uids.find((u) => u !== uid);
  return other === undefined ? { kind: 'own' } : { kind: 'other', uid: other };
}

const TABLES = ['/proc/net/tcp', '/proc/net/tcp6'];

/**
 * The owner of `port` on this machine; always `own` off Linux, where the CLI
 * does not check (see above). `tcp6` may be missing (IPv6 off); `tcp` may not.
 */
export async function checkListener(
  port: number,
  o: { platform?: NodeJS.Platform; uid?: number; read?: (path: string) => Promise<string> } = {},
): Promise<ListenerOwner> {
  const platform = o.platform ?? process.platform;
  const uid = o.uid ?? process.getuid?.();
  if (platform !== 'linux' || uid === undefined) return { kind: 'own' };
  const read = o.read ?? ((path: string) => readFile(path, 'utf8'));
  let v4: string;
  try {
    v4 = await read(TABLES[0]);
  } catch {
    return { kind: 'unknown' };
  }
  const v6 = await read(TABLES[1]).catch(() => '');
  return listenerOwner([v4, v6], port, uid);
}

/** Refusing to send the token: who holds the port instead. */
export function foreignListenerLine(port: number, uid: number): string {
  return `Another user's process (uid ${uid}) is listening on port ${port}, not your Orbital. The token was not sent.`;
}

/** The tables could not be read, so the owner of the port is not known. */
export function unknownListenerLine(port: number): string {
  return `Could not tell whose process listens on port ${port} (${TABLES[0]} unreadable). The token was not sent.`;
}
