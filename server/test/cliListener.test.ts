import { describe, expect, it } from 'vitest';
import { checkListener, listenerOwner, listenerUids } from '../src/cli/listener.js';

/**
 * Who listens on the port before the CLI sends its token (`listener.ts`).
 * The tables are written as the kernel prints them on x86: addresses in
 * host byte order, the port in hex, LISTEN as `0A`, the uid in column 8.
 */
const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (n: number, local: string, st: string, uid: number) =>
  `   ${n}: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 4242 1 0000000000000000 100 0 0 10 0`;
const HEAD6 = '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row6 = (n: number, local: string, uid: number) =>
  `   ${n}: ${local} 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 4243 1 0000000000000000 100 0 0 10 0`;

// 4747 is 0x128B.
const PORT = 4747;

describe('listenerUids', () => {
  it('reads the uid of a socket listening on 127.0.0.1 or 0.0.0.0 at the port', () => {
    const table = [HEAD, row(0, '0100007F:128B', '0A', 1000), row(1, '00000000:128B', '0A', 1001), ''].join('\n');
    expect(listenerUids(table, PORT)).toEqual([1000, 1001]);
  });

  it('skips another port, a socket not listening, an address 127.0.0.1 does not reach, and junk', () => {
    const table = [
      HEAD,
      row(0, '0100007F:0016', '0A', 1001),
      row(1, '0100007F:128B', '01', 1001),
      row(2, '0200007F:128B', '0A', 1001),
      row(3, '0100A8C0:128B', '0A', 1001),
      '   4: garbage',
    ].join('\n');
    expect(listenerUids(table, PORT)).toEqual([]);
  });

  it('reads tcp6: the dual-stack any address and ::ffff:127.0.0.1, not ::1', () => {
    const table = [
      HEAD6,
      row6(0, '00000000000000000000000000000000:128B', 1002),
      row6(1, '0000000000000000FFFF00000100007F:128B', 1003),
      row6(2, '00000000000000000000000001000000:128B', 1004),
    ].join('\n');
    expect(listenerUids(table, PORT)).toEqual([1002, 1003]);
  });
});

describe('listenerOwner', () => {
  const v4 = (uid: number) => [HEAD, row(0, '0100007F:128B', '0A', uid)].join('\n');

  it('is own only when every reachable listener is this user', () => {
    expect(listenerOwner([v4(1000), ''], PORT, 1000)).toEqual({ kind: 'own' });
    expect(listenerOwner([v4(1001), ''], PORT, 1000)).toEqual({ kind: 'other', uid: 1001 });
    const both = [v4(1000), [HEAD6, row6(0, '00000000000000000000000000000000:128B', 0)].join('\n')];
    expect(listenerOwner(both, PORT, 1000)).toEqual({ kind: 'other', uid: 0 });
  });

  it('is none when nothing listens', () => {
    expect(listenerOwner([HEAD, HEAD6], PORT, 1000)).toEqual({ kind: 'none' });
  });
});

describe('checkListener', () => {
  const tables = (files: Record<string, string>) => async (path: string) => {
    if (!(path in files)) throw new Error('ENOENT');
    return files[path];
  };

  it('does not look off Linux', async () => {
    await expect(checkListener(PORT, { platform: 'darwin', uid: 501, read: tables({}) })).resolves.toEqual({ kind: 'own' });
  });

  it('reads both tables on Linux, and goes on without tcp6', async () => {
    const tcp = [HEAD, row(0, '0100007F:128B', '0A', 1001)].join('\n');
    await expect(checkListener(PORT, { platform: 'linux', uid: 1000, read: tables({ '/proc/net/tcp': tcp }) }))
      .resolves.toEqual({ kind: 'other', uid: 1001 });
    const tcp6 = [HEAD6, row6(0, '0000000000000000FFFF00000100007F:128B', 1000)].join('\n');
    await expect(checkListener(PORT, {
      platform: 'linux', uid: 1000, read: tables({ '/proc/net/tcp': HEAD, '/proc/net/tcp6': tcp6 }),
    })).resolves.toEqual({ kind: 'own' });
  });

  it('is unknown when /proc/net/tcp cannot be read', async () => {
    await expect(checkListener(PORT, { platform: 'linux', uid: 1000, read: tables({}) })).resolves.toEqual({ kind: 'unknown' });
  });
});
