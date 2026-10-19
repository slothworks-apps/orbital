import { describe, expect, it, vi } from 'vitest';
import { CliError, NotRunning, httpCall } from '../src/cli/client.js';
import { createServer } from 'node:net';
import {
  checkListener, listenerOwner, listenerUids, portTakesConnection, type ListenerOwner,
} from '../src/cli/listener.js';

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

  it('is none when nothing listens on the port, while other sockets listen', () => {
    const ssh = [HEAD, row(0, '00000000:0016', '0A', 0)].join('\n');
    expect(listenerOwner([ssh, HEAD6], PORT, 1000)).toEqual({ kind: 'none' });
  });

  it('is unverifiable when the tables read but list no listening socket at all (WSL1, gVisor)', () => {
    expect(listenerOwner([HEAD, HEAD6], PORT, 1000)).toEqual({ kind: 'unverifiable' });
    expect(listenerOwner([[HEAD, row(0, '0100007F:128B', '01', 1000)].join('\n'), ''], PORT, 1000))
      .toEqual({ kind: 'unverifiable' });
  });
});

describe('checkListener', () => {
  const tables = (files: Record<string, string>) => async (path: string) => {
    if (!(path in files)) throw new Error('ENOENT');
    return files[path];
  };

  it('does not look on a Mac', async () => {
    await expect(checkListener(PORT, { platform: 'darwin', uid: 501, read: tables({}) })).resolves.toEqual({ kind: 'own' });
  });

  it('looks on any other system, and refuses one without the tables', async () => {
    const tcp = [HEAD, row(0, '0100007F:128B', '0A', 1000)].join('\n');
    await expect(checkListener(PORT, { platform: 'freebsd', uid: 1000, read: tables({ '/proc/net/tcp': tcp }) }))
      .resolves.toEqual({ kind: 'own' });
    await expect(checkListener(PORT, { platform: 'freebsd', uid: 1000, read: tables({}) })).resolves.toEqual({ kind: 'unknown' });
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

  it('tables that list no listener: asks the port, without a token — refused is not running, taken is unverifiable', async () => {
    const empty = tables({ '/proc/net/tcp': HEAD, '/proc/net/tcp6': HEAD6 });
    await expect(checkListener(PORT, { platform: 'linux', uid: 1000, read: empty, connects: async () => false }))
      .resolves.toEqual({ kind: 'none' });
    await expect(checkListener(PORT, { platform: 'linux', uid: 1000, read: empty, connects: async () => true }))
      .resolves.toEqual({ kind: 'unverifiable' });
  });

  it('is unknown when /proc/net/tcp cannot be read', async () => {
    await expect(checkListener(PORT, { platform: 'linux', uid: 1000, read: tables({}) })).resolves.toEqual({ kind: 'unknown' });
  });
});

describe('httpCall', () => {
  const answer = () => vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

  it('checks the listener before every request, and sends the token only to this user\'s', async () => {
    const fetchFn = answer();
    const owners: ListenerOwner[] = [{ kind: 'own' }, { kind: 'other', uid: 1001 }];
    const owner = vi.fn(async () => owners.shift()!);
    const call = httpCall(PORT, 'secret', fetchFn, owner);
    await expect(call('GET', '/api/remote')).resolves.toMatchObject({ status: 200 });
    await expect(call('GET', '/api/remote')).rejects.toThrow(CliError);
    expect(owner).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reads nothing listening as not running, and an unverifiable system as a refusal', async () => {
    const fetchFn = answer();
    const none = httpCall(PORT, 'secret', fetchFn, async () => ({ kind: 'none' }));
    await expect(none('GET', '/api/remote')).rejects.toBeInstanceOf(NotRunning);
    const blind = httpCall(PORT, 'secret', fetchFn, async () => ({ kind: 'unverifiable' }));
    await expect(blind('GET', '/api/remote')).rejects.toThrow(`Can't verify who listens on port ${PORT} on this system`);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('portTakesConnection', () => {
  it('is true for a port something listens on, false once it is gone', async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await expect(portTakesConnection(port)).resolves.toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(portTakesConnection(port)).resolves.toBe(false);
  });
});
