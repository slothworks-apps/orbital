import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { generateIdentity, deviceId } from '@orbital/shared/remote/keys';
import { encodePairingCode } from '@orbital/shared/remote/relayApi';
import { JOIN_REACH, attemptsLine, CODE_REJECTED, GROUP_FULL } from '@orbital/shared/remote/groupWords';
import { buildServer } from '../src/index.js';
import { parseArgs } from '../src/cli/args.js';
import { TokenRefused, httpCall, type Call, type Method, type Reply } from '../src/cli/client.js';
import { findDevice, runCli } from '../src/cli/commands.js';
import { addFlow, addVerdict, joinFlow, joinVerdict } from '../src/cli/flows.js';
import type { Io } from '../src/cli/io.js';
import { cliTarget } from '../src/cli/target.js';
import { listLines } from '../src/cli/words.js';
import { DEFAULT_PORT } from '../src/config.js';
import type { RemoteStatus } from '../src/remote/service.js';
import { makeTmpDir } from './tmp.js';

describe('parseArgs', () => {
  it('reads every command of the table', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' });
    expect(parseArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseArgs(['relay'])).toEqual({ kind: 'relay' });
    expect(parseArgs(['relay', 'set', 'wss://r.example'])).toEqual({ kind: 'relaySet', url: 'wss://r.example', yes: false });
    expect(parseArgs(['join'])).toEqual({ kind: 'join', code: null });
    expect(parseArgs(['join', 'abc'])).toEqual({ kind: 'join', code: 'abc' });
    expect(parseArgs(['devices', 'join', 'abc'])).toEqual({ kind: 'join', code: 'abc' });
    expect(parseArgs(['devices', 'add'])).toEqual({ kind: 'add' });
    expect(parseArgs(['devices', 'list'])).toEqual({ kind: 'list' });
    expect(parseArgs(['devices', 'rename', 'gpu', 'box'])).toEqual({ kind: 'rename', name: 'gpu box' });
    expect(parseArgs(['devices', 'remove', 'mac'])).toEqual({ kind: 'remove', target: 'mac', yes: false });
    expect(parseArgs(['devices', 'leave', '--yes'])).toEqual({ kind: 'leave', yes: true });
    expect(parseArgs(['-y', 'update'])).toEqual({ kind: 'update', yes: true });
  });

  it('takes --help anywhere, and a name that starts with a dash after --', () => {
    expect(parseArgs(['devices', 'remove', '--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['devices', 'rename', '--', '-dash'])).toEqual({ kind: 'rename', name: '-dash' });
  });

  it('refuses what it does not take', () => {
    for (const argv of [
      ['bogus'], ['status', 'x'], ['relay', 'get'], ['relay', 'set'], ['relay', 'set', 'a', 'b'], ['join', 'a', 'b'],
      ['devices'], ['devices', 'nuke'], ['devices', 'rename'], ['devices', 'remove', ' '], ['--force'],
      ['status', '--yes'], ['devices', 'list', '-y'],
    ]) {
      expect(parseArgs(argv).kind, argv.join(' ')).toBe('usage');
    }
  });
});

describe('cliTarget', () => {
  const home = '/home/u';
  it('reads the server default port and the token in the data dir', () => {
    expect(cliTarget({ env: {}, home, platform: 'linux' })).toEqual({ port: DEFAULT_PORT, tokenFile: '/home/u/.local/share/orbital/api-token' });
    expect(cliTarget({ env: { ORBITAL_PORT: '4838', ORBITAL_DATA_DIR: '/d' }, home, platform: 'darwin' }))
      .toEqual({ port: 4838, tokenFile: '/d/api-token' });
    expect(cliTarget({ env: {}, home, platform: 'darwin' })).toMatchObject({
      tokenFile: '/home/u/Library/Application Support/orbital/api-token',
    });
  });

  it('refuses a port that is no port', () => {
    for (const p of ['0', '65536', 'abc', '12.5', '-1', '0x10']) {
      expect(cliTarget({ env: { ORBITAL_PORT: p }, home, platform: 'linux' })).toHaveProperty('error');
    }
  });
});

const NOW = 1_000_000;

type Member = RemoteStatus['group']['members'][number];

function member(over: Partial<Member>): Member {
  return {
    id: 'id', kind: 'desktop', addedAt: 0, addedVersion: 1, name: 'm', os: 'macos', links: true, describedAt: 0,
    primary: false, self: false, linked: true, online: true, pairByHand: false, state: 'online', seenAt: null,
    tooOld: false, version: '0.35.0', ...over,
  } as Member;
}

function status(over: Partial<RemoteStatus> = {}, group: Partial<RemoteStatus['group']> = {}): RemoteStatus {
  return {
    enabled: true, relay: 'online', relayTooOld: null, relayAttempts: 0, relayUrl: 'wss://relay.example', macId: 'self-id',
    macName: 'gpu-box', devices: [], pendingPair: null, pairing: null, joining: null, error: null,
    ...over,
    group: {
      members: [member({ id: 'self-id', name: 'gpu-box', kind: 'headless', os: 'linux', self: true, state: 'self' })],
      relayLocked: false, primary: null, isPrimary: false, ended: null, pendingJoin: null, joinExpired: null,
      ...group,
    },
  };
}

function paired(id: string, name: string) {
  return { id, name, platform: 'darwin', kind: 'desktop', pairedAt: 0, lastSeenAt: null, online: true, needsUpdate: null } as RemoteStatus['devices'][number];
}

describe('listLines', () => {
  it('aligns one line per member, marks the primary and this device, and lists pairs outside the group', () => {
    const lines = listLines(status({ devices: [paired('mac', 'mac-studio'), paired('old', 'old-mac')] }, {
      members: [
        member({ id: 'mac', name: 'mac-studio', primary: true }),
        member({ id: 'self-id', name: 'gpu-box', kind: 'headless', os: 'linux', self: true, state: 'self', version: '0.35.1' }),
        member({ id: 'p', name: 'Pixel', kind: 'phone', os: 'android', state: 'offline', version: null }),
        member({ id: 'x', name: 'x', os: '', tooOld: true }),
      ],
    }));
    expect(lines).toEqual([
      'NAME        KIND      OS       STATE    VERSION',
      'mac-studio  desktop   macOS    online   0.35.0   primary',
      'gpu-box     headless  Linux    online   0.35.1   this device',
      'Pixel       phone     Android  offline  —',
      'x           desktop   —        too old  0.35.0',
      'old-mac     desktop   macOS    online   —        paired here, not in the group',
    ]);
  });

  it('shows this device offline while its relay is not on line', () => {
    expect(listLines(status({ relay: 'connecting' }))[1]).toMatch(/^gpu-box +headless +Linux +offline/);
  });
});

describe('findDevice', () => {
  const remote = status({ devices: [paired('aaaa1111', 'mac'), paired('bbbb2222', 'mac'), paired('cccc3333', 'pixel')] }, {
    members: [member({ id: 'self-id', name: 'gpu-box', self: true })],
  });

  it('finds by id, by name, by an id prefix of four or more', () => {
    expect(findDevice(remote, 'aaaa1111')).toMatchObject({ id: 'aaaa1111' });
    expect(findDevice(remote, 'pixel')).toMatchObject({ id: 'cccc3333' });
    expect(findDevice(remote, 'cccc')).toMatchObject({ id: 'cccc3333' });
    expect(findDevice(remote, 'gpu-box')).toMatchObject({ self: true });
  });

  it('refuses a name two devices share, a short prefix and nothing', () => {
    expect(findDevice(remote, 'mac')).toEqual({ error: expect.stringContaining('aaaa1111, bbbb2222') });
    expect(findDevice(remote, 'ccc')).toHaveProperty('error');
    expect(findDevice(remote, 'nope')).toHaveProperty('error');
  });
});

/** A terminal that answers from a script and records what was said. */
function scriptedIo(answers: (string | null)[] = [], waits: ('tick' | 'interrupt')[] = []) {
  const io = {
    out: [] as string[], err: [] as string[], asked: [] as string[], clock: NOW,
  };
  const api: Io = {
    out: (l) => void io.out.push(l),
    err: (l) => void io.err.push(l),
    ask: async (q) => {
      io.asked.push(q);
      return answers.length ? answers.shift()! : null;
    },
    wait: async (ms) => {
      io.clock += ms;
      return waits.shift() ?? 'tick';
    },
    now: () => io.clock,
  };
  return { io, api };
}

/**
 * A server that answers `GET /api/remote` from `snapshots` in turn (the last
 * repeats) and every other route from `routes`, recording each call.
 */
function fakeServer(snapshots: RemoteStatus[], routes: Record<string, Reply | ((body: unknown) => Reply)> = {}) {
  const calls: { method: Method; path: string; body?: unknown }[] = [];
  const call: Call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/api/remote') return { status: 200, body: snapshots.length > 1 ? snapshots.shift() : snapshots[0] };
    const route = routes[`${method} ${path}`];
    if (!route) return { status: 404, body: { error: 'not_found' } };
    return typeof route === 'function' ? route(body) : route;
  };
  return { call, calls };
}

describe('joinVerdict', () => {
  const target = { device: 'mac', expiresAt: NOW + 60_000 };
  const joining = { device: 'mac', name: 'mac', kind: 'desktop', code: '1234-5678', expiresAt: target.expiresAt, manager: null };

  it('waits while the join is under way, then reads how it ended', () => {
    expect(joinVerdict(status({ joining }), target, NOW)).toBe('waiting');
    expect(joinVerdict(status({ joining }), target, target.expiresAt)).toBe('expired');
    expect(joinVerdict(status({}, { pendingJoin: { primary: 'mac', expiresAt: target.expiresAt } }), target, NOW)).toBe('paired');
    expect(joinVerdict(status({}, { joinExpired: { id: 'mac', name: 'mac' } }), target, NOW)).toBe('neverSent');
    expect(joinVerdict(status({ devices: [paired('mac', 'mac')] }), target, NOW)).toBe('joined');
    expect(joinVerdict(status(), target, NOW)).toBe('rejected');
    expect(joinVerdict(status(), target, target.expiresAt + 1)).toBe('expired');
    expect(joinVerdict(status({ relay: 'connecting' }), target, NOW)).toBe('relayDown');
  });
});

describe('addVerdict', () => {
  const expiresAt = NOW + 60_000;
  it('tells a request, the code still open, run out, spent and replaced apart', () => {
    const pendingPair = { phone: 'p', name: 'Pixel', platform: 'android', kind: 'phone', attemptsLeft: 3, manager: null };
    expect(addVerdict(status({ pendingPair }), expiresAt, NOW)).toBe('request');
    expect(addVerdict(status({ pairing: { expiresAt } }), expiresAt, NOW)).toBe('waiting');
    expect(addVerdict(status({ pairing: { expiresAt } }), expiresAt, expiresAt)).toBe('expired');
    expect(addVerdict(status({ pairing: null }), expiresAt, NOW)).toBe('refused');
    expect(addVerdict(status({ pairing: { expiresAt: expiresAt + 5 } }), expiresAt, NOW)).toBe('replaced');
  });
});

describe('joinFlow', () => {
  const macKey = generateIdentity().publicKey;
  const mac = deviceId(macKey);
  const qr = (over: object = {}) => encodePairingCode(JSON.stringify({
    v: 1, relay: 'wss://relay.example', mac, name: 'mac-studio', token: 't', secret: 's', kind: 'desktop',
    expiresAt: NOW + 120_000, ...over,
  }));
  const joining = { device: mac, name: 'mac-studio', kind: 'desktop', code: 'ABCD-1234', expiresAt: NOW + 120_000, manager: { by: 'there' as const, newGroup: true } };
  const joined = { status: 200, body: { device: mac, name: 'mac-studio', code: 'ABCD-1234' } };

  it('asks for the code, prints the one to type there, and waits through pairing to joined', async () => {
    const { call, calls } = fakeServer([
      status(), status({ joining }), status({ joining }),
      status({ devices: [paired(mac, 'mac-studio')] }, { pendingJoin: { primary: mac, expiresAt: NOW + 120_000 } }),
      status({ devices: [paired(mac, 'mac-studio')] }, { members: [member({ id: mac, primary: true })] }),
    ], { 'POST /api/remote/join': joined });
    const { io, api } = scriptedIo([qr()]);
    expect(await joinFlow({ call, io: api }, null)).toBe(0);
    expect(io.asked).toHaveLength(1);
    expect(calls.find((c) => c.path === '/api/remote/join')?.body).toEqual({ code: qr() });
    expect(io.out).toEqual([
      'Type this code on mac-studio: ABCD-1234',
      'mac-studio will manage the group: devices are added and removed there.',
      'Waiting for mac-studio… Ctrl-C cancels.',
      'Paired. Waiting for the group from mac-studio…',
      'Joined: mac-studio.',
      'mac-studio manages the group: add more devices there.',
    ]);
  });

  it('cancels the join on Ctrl-C', async () => {
    const { call, calls } = fakeServer([status(), status({ joining })], {
      'POST /api/remote/join': joined, 'DELETE /api/remote/join': { status: 200, body: { ok: true } },
    });
    const { io, api } = scriptedIo([], ['tick', 'interrupt']);
    expect(await joinFlow({ call, io: api }, qr())).toBe(1);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/remote/join' });
    expect(io.out.at(-1)).toBe('Join cancelled.');
  });

  it('says a rejection, and not_primary naming the primary', async () => {
    let s = fakeServer([status(), status({ joining }), status()], { 'POST /api/remote/join': joined });
    let t = scriptedIo();
    expect(await joinFlow({ call: s.call, io: t.api }, qr())).toBe(1);
    expect(t.io.err[0]).toMatch(/^Request rejected\. mac-studio didn't let this device in/);

    s = fakeServer([status()], {
      'POST /api/remote/join': { status: 403, body: { error: 'not_primary', primary: { id: 'x', name: 'imac' } } },
    });
    t = scriptedIo();
    expect(await joinFlow({ call: s.call, io: t.api }, qr())).toBe(1);
    expect(t.io.err).toEqual(['imac manages this group — add devices there.']);
  });

  it('refuses before asking the server: no code, its own code, another relay, run out', async () => {
    const own = encodePairingCode(JSON.stringify({ v: 1, relay: 'wss://relay.example', mac, name: 'me', token: 't', secret: 's' }));
    for (const [code, snapshot, line] of [
      ['nonsense', status(), "That isn't a device code."],
      [own, status({ macId: mac }), "That's this device's own code."],
      [qr({ relay: 'wss://other.example' }), status(), /uses another relay.*orbital relay set wss:\/\/other\.example/],
      [qr({ expiresAt: NOW - 1 }), status(), /^Code expired/],
    ] as const) {
      const s = fakeServer([snapshot]);
      const t = scriptedIo();
      expect(await joinFlow({ call: s.call, io: t.api }, code)).toBe(1);
      expect(t.io.err[0]).toMatch(line);
      expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
    }
  });

  it('reads a join whose roster never came, and marks the notice read', async () => {
    const { call, calls } = fakeServer([
      status(), status({ joining }), status({}, { joinExpired: { id: mac, name: 'mac-studio' } }),
    ], { 'POST /api/remote/join': joined, 'POST /api/remote/join/expired/acknowledge': { status: 200, body: { ok: true } } });
    const { io, api } = scriptedIo();
    expect(await joinFlow({ call, io: api }, qr())).toBe(1);
    expect(io.err[0]).toMatch(/^mac-studio never sent the group/);
    expect(calls.at(-1)).toMatchObject({ path: '/api/remote/join/expired/acknowledge' });
  });
});

describe('addFlow', () => {
  const pendingPair = {
    phone: 'p1', name: 'Pixel 8', platform: 'android', kind: 'phone', attemptsLeft: 3,
    manager: { by: 'here' as const, newGroup: true },
  };
  const expiresAt = NOW + 120_000;
  const code = { status: 200, body: { qr: '{"v":1}', expiresAt } };

  it('shows the code, says the 50c sentence, and takes the code the device shows after a wrong one', async () => {
    let tries = 0;
    const { call, calls } = fakeServer([
      status(), status({ pairing: { expiresAt } }), status({ pairing: { expiresAt }, pendingPair }),
    ], {
      'POST /api/remote/pair': code,
      'POST /api/remote/pair/confirm': () => (++tries === 1
        ? { status: 422, body: { error: 'code_mismatch', attemptsLeft: 2 } }
        : { status: 200, body: { ok: true } }),
    });
    const { io, api } = scriptedIo(['1111-2222', 'ABCD-1234']);
    expect(await addFlow({ call, io: api })).toBe(0);
    expect(io.out).toContain('eyJ2IjoxfQ');
    expect(io.out).toContain(`It works for 2:00. Waiting for a request… Ctrl-C stops.`);
    expect(io.out).toContain(`Pixel 8 (phone, Android) wants to join. ${JOIN_REACH}`);
    expect(io.out).toContain('This device will manage the group: devices are added and removed here.');
    expect(io.err).toEqual([attemptsLine(2)]);
    expect(io.out).toContain('Pixel 8 joined.');
    expect(calls.filter((c) => c.path === '/api/remote/pair/confirm').map((c) => c.body)).toEqual([
      { accept: true, phone: 'p1', code: '1111-2222' }, { accept: true, phone: 'p1', code: 'ABCD-1234' },
    ]);
  });

  it('answers a request already waiting without a new code; Enter rejects it', async () => {
    const { call, calls } = fakeServer([status({ pendingPair })], {
      'POST /api/remote/pair/confirm': { status: 200, body: { ok: true } },
    });
    const { io, api } = scriptedIo(['']);
    expect(await addFlow({ call, io: api })).toBe(0);
    expect(calls.some((c) => c.path === '/api/remote/pair')).toBe(false);
    expect(calls.at(-1)?.body).toEqual({ accept: false, phone: 'p1' });
    expect(io.out.at(-1)).toBe('Request rejected');
  });

  it('ends on the last wrong code, a full group, and a code that ran out', async () => {
    for (const [reply, lines] of [
      [{ status: 409, body: { error: 'code_rejected' } }, [CODE_REJECTED]],
      [{ status: 409, body: { error: 'group_full' } }, [GROUP_FULL, expect.stringMatching(/^Pixel 8 wasn’t added/)]],
      [{ status: 404, body: { error: 'no_pending' } }, [expect.stringMatching(/^The request is gone/)]],
    ] as const) {
      const s = fakeServer([status({ pendingPair })], { 'POST /api/remote/pair/confirm': reply });
      const t = scriptedIo(['ABCD-1234']);
      expect(await addFlow({ call: s.call, io: t.api })).toBe(1);
      expect(t.io.err).toEqual(lines);
    }
    const s = fakeServer([status(), status({ pairing: { expiresAt } })], { 'POST /api/remote/pair': code });
    const t = scriptedIo();
    expect(await addFlow({ call: s.call, io: t.api })).toBe(1);
    expect(t.io.err).toEqual(['The code expired before a device asked. Run orbital devices add again.']);
  });

  it('gives a member the not_primary line naming the primary', async () => {
    const s = fakeServer([status()], {
      'POST /api/remote/pair': { status: 403, body: { error: 'not_primary', primary: { id: 'm', name: 'mac-studio' } } },
    });
    const t = scriptedIo();
    expect(await addFlow({ call: s.call, io: t.api })).toBe(1);
    expect(t.io.err).toEqual(['mac-studio manages this group — add devices there.']);
  });
});

describe('confirmations', () => {
  const group = status({ devices: [paired('mac', 'mac-studio')] }, {
    members: [member({ id: 'self-id', name: 'gpu-box', self: true, primary: true }), member({ id: 'mac', name: 'mac-studio' })],
    isPrimary: true, primary: { id: 'self-id', name: 'gpu-box' }, relayLocked: true,
  });

  it('asks before a removal, and only a yes removes', async () => {
    for (const [answer, removed] of [['n', false], ['', false], ['y', true], ['YES', true]] as const) {
      const s = fakeServer([group], { 'DELETE /api/remote/devices/mac': { status: 200, body: { ok: true } } });
      const t = scriptedIo([answer]);
      expect(await runCli(['devices', 'remove', 'mac-studio'], { call: s.call, io: t.api, port: 1 })).toBe(removed ? 0 : 1);
      expect(t.io.asked[0]).toBe('Remove mac-studio? It drops out of every device in the group now and has to be paired again from here. [y/N] ');
      expect(s.calls.some((c) => c.method === 'DELETE')).toBe(removed);
    }
  });

  it('dissolves on the primary with the dissolve words, and --yes skips the question', async () => {
    const s = fakeServer([group], { 'POST /api/remote/leave': { status: 200, body: { ok: true } } });
    const t = scriptedIo();
    expect(await runCli(['devices', 'leave', '--yes'], { call: s.call, io: t.api, port: 1 })).toBe(0);
    expect(t.io.asked).toEqual([]);
    expect(t.io.out).toEqual(['The group is dissolved.']);
    const u = scriptedIo(['n']);
    await runCli(['devices', 'leave'], { call: fakeServer([group]).call, io: u.api, port: 1 });
    expect(u.io.asked[0]).toMatch(/^Dissolve the group\? The other device becomes standalone/);
  });

  it('keeps the relay while in a group', async () => {
    const s = fakeServer([group]);
    const t = scriptedIo();
    expect(await runCli(['relay', 'set', 'wss://new.example'], { call: s.call, io: t.api, port: 1 })).toBe(1);
    expect(t.io.err).toEqual(['One relay for the whole group. Remove the other devices, or dissolve the group, to change it.']);
  });

  it('sets the relay and turns the remote on', async () => {
    const s = fakeServer([status({ enabled: false, relayUrl: '' })], { 'PATCH /api/settings': { status: 200, body: { ok: true } } });
    const t = scriptedIo();
    expect(await runCli(['relay', 'set', 'wss://new.example'], { call: s.call, io: t.api, port: 1 })).toBe(0);
    expect(s.calls.at(-1)?.body).toEqual({ remote_relay_url: 'wss://new.example', remote_enabled: 'true' });
  });

  it('asks before an update that stops working sessions', async () => {
    const state = { installed: '0.35.0', candidate: '0.36.0', packaged: true, updating: false, failed: null, sessions: 2 };
    const s = fakeServer([status()], {
      'GET /api/server/update': { status: 200, body: state },
      'POST /api/server/update': { status: 202, body: { ...state, updating: true } },
    });
    const t = scriptedIo(['y']);
    expect(await runCli(['update'], { call: s.call, io: t.api, port: 1 })).toBe(0);
    expect(t.io.asked[0]).toMatch(/^2 sessions are working here\..*Update to 0\.36\.0 now\? \[y\/N\] $/);
    expect(s.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/server/update' });
  });
});

describe('the CLI against a running server', () => {
  it('runs status and devices list through the token', async () => {
    const claudeDir = makeTmpDir('cli-claude');
    const app = await buildServer({
      claudeDir, dbPath: join(claudeDir, 'index.db'), dataDir: makeTmpDir('cli-data'), queryFn: (() => {}) as any,
      apiToken: 'cli-test-token',
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      const call = httpCall(port, 'cli-test-token');

      const t = scriptedIo();
      expect(await runCli(['status'], { call, io: t.api, port })).toBe(0);
      expect(t.io.out[0]).toBe(`Orbital dev is running on port ${port}.`);
      expect(t.io.out).toContain('Relay: not set. Set one: orbital relay set <url>');
      expect(t.io.out).toContain('Group: none, this device is alone.');

      const l = scriptedIo();
      expect(await runCli(['devices', 'list'], { call, io: l.api, port })).toBe(0);
      expect(l.io.out[0]).toMatch(/^NAME +KIND +OS +STATE +VERSION$/);

      // Another token is refused, not mistaken for a server that is down.
      await expect(httpCall(port, 'wrong')('GET', '/api/remote')).rejects.toBeInstanceOf(TokenRefused);
    } finally {
      await app.close();
    }
  });
});
