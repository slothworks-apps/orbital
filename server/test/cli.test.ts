import { describe, expect, it } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { generateIdentity, deviceId } from '@orbital/shared/remote/keys';
import { encodePairingCode } from '@orbital/shared/remote/relayApi';
import {
  CODE_REJECTED, GROUP_FULL, JOIN_REACH, attemptsLine, exitWords, groupFullBody, groupFullLine, joinSentence, managerWords,
  notPrimaryAddLine, relayChangeWords, relayLockedLine, removeWords, updateSessionsWords,
} from '@orbital/shared/remote/groupWords';
import type { ServerUpdateState } from '@orbital/shared/remote/serverUpdate';
import { ROSTER_MAX_ENTRIES } from '@orbital/shared/remote/roster';
import { buildServer } from '../src/index.js';
import { parseArgs } from '../src/cli/args.js';
import { TokenRefused, httpCall, type Call, type Method, type Reply } from '../src/cli/client.js';
import { findDevice, runCli, updateTarget } from '../src/cli/commands.js';
import { REQUEST_EXPIRED, addFlow, addVerdict, joinFlow, joinVerdict } from '../src/cli/flows.js';
import { TIMED_OUT, type Io } from '../src/cli/io.js';
import { cliTarget, readToken, rootHint, unreadableTokenLine } from '../src/cli/target.js';
import { listLines, remoteDownLine, remoteErrorLine, statusLines } from '../src/cli/words.js';
import { BAD_SECRET_ERROR } from '../src/remote/errors.js';
import { DEFAULT_PORT } from '../src/config.js';
import type { RemoteStatus } from '../src/remote/service.js';
import { makeTmpDir } from './tmp.js';

describe('parseArgs', () => {
  it('reads every command of the table', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' });
    expect(parseArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseArgs(['relay'])).toEqual({ kind: 'relay' });
    expect(parseArgs(['relay', 'set', 'wss://r.example'])).toEqual({ kind: 'relaySet', url: 'wss://r.example', secret: 'keep', yes: false });
    expect(parseArgs(['join'])).toEqual({ kind: 'join', code: null });
    expect(parseArgs(['join', 'abc'])).toEqual({ kind: 'join', code: 'abc' });
    expect(parseArgs(['devices', 'join', 'abc'])).toEqual({ kind: 'join', code: 'abc' });
    expect(parseArgs(['devices', 'add'])).toEqual({ kind: 'add' });
    expect(parseArgs(['devices', 'list'])).toEqual({ kind: 'list' });
    expect(parseArgs(['devices', 'rename', 'gpu', 'box'])).toEqual({ kind: 'rename', name: 'gpu box' });
    expect(parseArgs(['devices', 'remove', 'mac'])).toEqual({ kind: 'remove', target: 'mac', yes: false });
    expect(parseArgs(['devices', 'leave', '--yes'])).toEqual({ kind: 'leave', yes: true });
    expect(parseArgs(['-y', 'update'])).toEqual({ kind: 'update', target: null, yes: true, when: 'now' });
    expect(parseArgs(['update', 'nuc'])).toEqual({ kind: 'update', target: 'nuc', yes: false, when: 'now' });
    expect(parseArgs(['update', 'Pixel', '8', '--yes'])).toEqual({ kind: 'update', target: 'Pixel 8', yes: true, when: 'now' });
    expect(parseArgs(['update', '--when-idle', 'nuc'])).toEqual({ kind: 'update', target: 'nuc', yes: false, when: 'idle' });
    expect(parseArgs(['update', '--cancel'])).toEqual({ kind: 'updateCancel', target: null });
    expect(parseArgs(['update', 'gpu', 'box', '--cancel'])).toEqual({ kind: 'updateCancel', target: 'gpu box' });
  });

  it('takes --when-idle and --cancel only for update, and not together', () => {
    for (const argv of [
      ['status', '--when-idle'], ['devices', 'list', '--cancel'], ['update', '--cancel', '--when-idle'],
      ['update', '--cancel', '--yes'], ['devices', 'remove', 'nuc', '--cancel'],
    ]) {
      expect(parseArgs(argv).kind, argv.join(' ')).toBe('usage');
    }
  });

  it('takes --help anywhere, and a name that starts with a dash after --', () => {
    expect(parseArgs(['devices', 'remove', '--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['devices', 'rename', '--', '-dash'])).toEqual({ kind: 'rename', name: '-dash' });
  });

  it('reads the relay secret from a prompt or stdin, never from an argument', () => {
    expect(parseArgs(['relay', 'set', 'wss://r', '--secret'])).toMatchObject({ kind: 'relaySet', secret: 'prompt' });
    expect(parseArgs(['relay', 'set', 'wss://r', '--secret-stdin'])).toMatchObject({ kind: 'relaySet', secret: 'stdin' });
    expect(parseArgs(['relay', 'set', 'wss://r'])).toMatchObject({ kind: 'relaySet', secret: 'keep' });
    expect(parseArgs(['relay', 'secret'])).toEqual({ kind: 'relaySecret', secret: 'prompt', yes: false });
    expect(parseArgs(['relay', 'secret', '--secret-stdin', '-y'])).toEqual({ kind: 'relaySecret', secret: 'stdin', yes: true });
    expect(parseArgs(['relay', 'secret', '--clear'])).toEqual({ kind: 'relaySecret', secret: 'clear', yes: false });
    for (const argv of [
      ['relay', 'set', 'wss://r', '--secret=hunter2'], ['relay', 'set', 'wss://r', '--secret', '--secret-stdin'],
      ['relay', 'secret', '--secret'], ['relay', 'set', 'wss://r', '--clear'], ['status', '--secret-stdin'],
      ['relay', 'secret', 'hunter2'],
    ]) {
      expect(parseArgs(argv).kind, argv.join(' ')).toBe('usage');
    }
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

  it("takes the shell's port first, then the user unit's, then the default", () => {
    const unitEnvironment = 'Environment=ORBITAL_HEADLESS=1 ORBITAL_PORT=4800\n';
    expect(cliTarget({ env: {}, home, platform: 'linux', unitEnvironment })).toMatchObject({ port: 4800 });
    expect(cliTarget({ env: { ORBITAL_PORT: '4900' }, home, platform: 'linux', unitEnvironment })).toMatchObject({ port: 4900 });
    expect(cliTarget({ env: { ORBITAL_PORT: '' }, home, platform: 'linux', unitEnvironment })).toMatchObject({ port: 4800 });
    for (const none of ['Environment=ORBITAL_HEADLESS=1\n', 'Environment=ORBITAL_PORT=99999', '', null]) {
      expect(cliTarget({ env: {}, home, platform: 'linux', unitEnvironment: none })).toMatchObject({ port: DEFAULT_PORT });
    }
    // A shell port that is no port is refused even with the unit's at hand.
    expect(cliTarget({ env: { ORBITAL_PORT: 'abc' }, home, platform: 'linux', unitEnvironment })).toHaveProperty('error');
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

  it('shows each member\'s OS version where it named one, and an UPDATE column only when one has something to say', () => {
    const remote = status({}, {
      members: [
        member({ id: 'self-id', name: 'gpu-box', kind: 'headless', os: 'linux', osVersion: 'Ubuntu 24.04', self: true, state: 'self' }),
        member({ id: 'mac', name: 'mac-studio', osVersion: 'macOS 14.6', version: '0.35.0' }),
      ],
    });
    const up = (over: Partial<ServerUpdateState>): ServerUpdateState => ({
      installed: '0.35.0', candidate: '0.35.0', packaged: true, updating: false, failed: null, sessions: 0, startedBy: null, ...over,
    });
    expect(listLines(remote, new Map([['self-id', up({})]]))).toEqual([
      'NAME        KIND      OS            STATE   VERSION',
      'gpu-box     headless  Ubuntu 24.04  online  0.35.0   this device',
      'mac-studio  desktop   macOS 14.6    online  0.35.0',
    ]);
    const lines = listLines(remote, new Map([
      ['self-id', up({ installed: '0.35.2', candidate: '0.36.0' })],
      ['mac', up({ updating: true, candidate: '0.36.0' })],
    ]));
    expect(lines[0]).toMatch(/VERSION +UPDATE$/);
    expect(lines[1]).toMatch(/0\.35\.2 +update available · 0\.36\.0 +this device$/);
    expect(lines[2]).toMatch(/updating to 0\.36\.0$/);
    expect(listLines(remote, new Map([['mac', up({ failed: '0.36.0', candidate: '0.36.0' })]]))[2])
      .toMatch(/update didn’t finish · still on 0\.35\.0$/);
    // A Mac where a session started while it downloaded: the update waits there.
    expect(listLines(remote, new Map([['mac', up({ failed: '0.36.0', candidate: '0.36.0', failedReason: 'sessions' })]]))[2])
      .toMatch(/didn’t install · a session started working on mac-studio$/);
    // Could not tell which sessions worked there.
    expect(listLines(remote, new Map([['mac', up({ failed: '0.36.0', candidate: '0.36.0', failedReason: 'unknown' })]]))[2])
      .toMatch(/couldn’t check for sessions on mac-studio$/);
    // Waiting for its sessions, with the live count.
    expect(listLines(remote, new Map([['mac', up({ updating: true, candidate: '0.36.0', waiting: { sessions: 2 } })]]))[2])
      .toMatch(/waiting for 2 sessions to finish · then 0\.36\.0$/);
  });

  it('status says a Mac\'s update waits on it, in the words its rows say', () => {
    const update: ServerUpdateState = {
      installed: '0.35.0', candidate: '0.36.0', packaged: true, updating: false, failed: '0.36.0', sessions: 1, startedBy: null,
      failedReason: 'sessions',
    };
    const remote = status({ macName: 'studio' });
    expect(statusLines(remote, update, 4848)).toContain(
      'The update to 0.36.0 didn’t install · a session started working on studio: it’s downloaded there · restart it on studio.',
    );
    expect(statusLines(remote, { ...update, failedReason: 'unknown' }, 4848)).toContain(
      'The update to 0.36.0 didn’t install: couldn’t check for sessions on studio · nothing was started.',
    );
    const waiting = { ...update, failed: null, failedReason: null, updating: true, waiting: { sessions: 1 }, startedBy: { id: 'p', name: 'Pixel 8' } };
    expect(statusLines(remote, waiting, 4848)).toContain(
      'Waiting for 1 session to finish · then 0.36.0, started on Pixel 8. orbital update --cancel stops the wait.',
    );
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

describe('cliTarget hints', () => {
  it('reads an unreadable token as another user\'s, and points root at the service user', async () => {
    const dir = makeTmpDir('cli-token');
    const file = join(dir, 'api-token');
    writeFileSync(file, 'tok\n');
    expect(await readToken(file)).toEqual({ token: 'tok' });
    expect(await readToken(join(dir, 'none'))).toEqual({ missing: true });
    if (process.getuid?.() !== 0) {
      chmodSync(file, 0o000);
      expect(await readToken(file)).toEqual({ unreadable: true });
    }
    expect(rootHint(1000, 'orbital')).toBeNull();
    expect(rootHint(0, 'deploy\n')).toContain('sudo -u deploy');
    expect(rootHint(0, null)).not.toBeNull();
    // A file that names no user is not echoed.
    expect(rootHint(0, 'x; rm -rf /')).not.toContain('rm');
    // The token is the service user's: name that user, for root and anyone else alike.
    expect(unreadableTokenLine(file, 'orbital\n')).toContain('sudo -u orbital orbital');
    expect(unreadableTokenLine(file, null)).not.toContain('sudo');
    expect(unreadableTokenLine(file, '$(reboot)')).not.toContain('reboot');
  });
});

describe('remoteDownLine', () => {
  it('says why the remote did not start, with the secret fix for a refused secret', () => {
    const base = { enabled: true, relayUrl: 'wss://r', relay: 'off' as const };
    expect(remoteDownLine({ ...base, error: BAD_SECRET_ERROR })).toBe(remoteErrorLine(BAD_SECRET_ERROR));
    expect(remoteErrorLine(BAD_SECRET_ERROR)).toContain('orbital relay secret');
    expect(remoteDownLine({ ...base, error: 'boom' })).toContain('boom');
    expect(remoteDownLine({ ...base, error: null })).not.toContain('boom');
  });
});

/**
 * A terminal that answers from a script and records what was said. `naps`:
 * what each sleep comes to — `interrupt` springs the trap as Ctrl-C would.
 */
function scriptedIo(answers: (string | null | typeof TIMED_OUT)[] = [], naps: ('tick' | 'interrupt')[] = []) {
  const io = {
    out: [] as string[], err: [] as string[], asked: [] as string[], secrets: 0, clock: NOW,
    spring: () => {},
  };
  const api: Io = {
    out: (l) => void io.out.push(l),
    err: (l) => void io.err.push(l),
    ask: async (q) => {
      io.asked.push(q);
      return answers.length ? answers.shift()! : null;
    },
    askSecret: async (q) => {
      io.asked.push(q);
      io.secrets++;
      const a = answers.shift();
      return typeof a === 'string' ? a : null;
    },
    sleep: (ms) => {
      io.clock += ms;
      if (naps.shift() === 'interrupt') {
        io.spring();
        return new Promise(() => {});
      }
      return Promise.resolve();
    },
    trap: () => {
      let fire!: () => void;
      const signal = new Promise<void>((r) => {
        fire = r;
      });
      io.spring = fire;
      return { signal, release: () => {} };
    },
    now: () => io.clock,
  };
  return { io, api };
}

/**
 * A server that answers `GET /api/remote` from `snapshots` in turn (the last
 * repeats) and every other route from `routes`, recording each call.
 */
function fakeServer(snapshots: RemoteStatus[], routes: Record<string, Reply | ((body: unknown) => Reply | Promise<Reply>)> = {}) {
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
  const target = { device: 'mac', expiresAt: NOW + 60_000, adds: false };
  const joining = { device: 'mac', name: 'mac', kind: 'desktop', code: '1234-5678', expiresAt: target.expiresAt, manager: null };

  it('waits while the join is under way, then reads how it ended', () => {
    expect(joinVerdict(status({ joining }), target, NOW)).toBe('waiting');
    expect(joinVerdict(status({ joining }), target, target.expiresAt)).toBe('expired');
    expect(joinVerdict(status({}, { pendingJoin: { primary: 'mac', expiresAt: target.expiresAt } }), target, NOW)).toBe('paired');
    expect(joinVerdict(status({}, { joinExpired: { id: 'mac', name: 'mac' } }), target, NOW)).toBe('neverSent');
    expect(joinVerdict(status({ devices: [paired('mac', 'mac')] }), target, NOW)).toBe('joined');
    expect(joinVerdict(status(), target, NOW)).toBe('ended');
    expect(joinVerdict(status(), target, target.expiresAt + 1)).toBe('expired');
    expect(joinVerdict(status({ relay: 'connecting' }), target, NOW)).toBe('relayDown');
    expect(joinVerdict(status({ enabled: false }), target, NOW)).toBe('relayDown');
  });

  it('reads a full group only where this device was the one to add', () => {
    const full = status({}, { members: Array.from({ length: ROSTER_MAX_ENTRIES }, (_, i) => member({ id: `m${i}` })) });
    expect(joinVerdict(full, { ...target, adds: true }, NOW)).toBe('full');
    expect(joinVerdict(full, target, NOW)).toBe('ended');
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
  const manager = { by: 'there' as const, newGroup: true };
  const joining = { device: mac, name: 'mac-studio', kind: 'desktop', code: 'ABCD-1234', expiresAt: NOW + 120_000, manager };
  const joined = { status: 200, body: { device: mac, name: 'mac-studio', code: 'ABCD-1234' } };
  const cancel = { 'DELETE /api/remote/join': { status: 200, body: { ok: true } } };

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
    expect(io.out.some((l) => l.includes('ABCD-1234'))).toBe(true);
    expect(io.out).toContain(managerWords(manager, 'mac-studio').line);
    expect(io.out).toContain(managerWords(manager, 'mac-studio').done);
    expect(io.err).toEqual([]);
  });

  it('cancels the join on Ctrl-C while waiting', async () => {
    const { call, calls } = fakeServer([status(), status({ joining })], { 'POST /api/remote/join': joined, ...cancel });
    const { api } = scriptedIo([], ['tick', 'interrupt']);
    expect(await joinFlow({ call, io: api }, qr())).toBe(1);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/remote/join' });
  });

  it('cancels the join on Ctrl-C during the request itself, once the server has answered it', async () => {
    let springIt = () => {};
    const { call, calls } = fakeServer([status()], {
      'POST /api/remote/join': async () => {
        springIt();
        await new Promise((r) => setTimeout(r, 5));
        return joined;
      },
      ...cancel,
    });
    const { io, api } = scriptedIo();
    const trap = api.trap.bind(api);
    api.trap = () => {
      const t = trap();
      springIt = io.spring;
      return t;
    };
    expect(await joinFlow({ call, io: api }, qr())).toBe(1);
    expect(calls.map((c) => `${c.method} ${c.path}`).slice(-2)).toEqual(['POST /api/remote/join', 'DELETE /api/remote/join']);
  });

  it('ends without blaming the other device, and reads a full group or a relay down where the status says so', async () => {
    for (const [after, line, adds] of [
      [status(), null, false],
      [status({ relay: 'connecting' }), null, false],
      [status({}, { members: Array.from({ length: ROSTER_MAX_ENTRIES }, (_, i) => member({ id: `m${i}` })) }), groupFullLine('mac-studio'), true],
    ] as const) {
      const j = { ...joining, manager: adds ? { by: 'here' as const, newGroup: false } : manager };
      const s = fakeServer([status(), status({ joining: j }), after], { 'POST /api/remote/join': joined });
      const t = scriptedIo();
      expect(await joinFlow({ call: s.call, io: t.api }, qr())).toBe(1);
      expect(t.io.err).toHaveLength(1);
      if (line) expect(t.io.err[0]).toBe(line);
      expect(t.io.err[0]).not.toMatch(/rejected|didn't let/i);
    }
  });

  it('gives not_primary naming the primary', async () => {
    const s = fakeServer([status()], {
      'POST /api/remote/join': { status: 403, body: { error: 'not_primary', primary: { id: 'x', name: 'imac' } } },
    });
    const t = scriptedIo();
    expect(await joinFlow({ call: s.call, io: t.api }, qr())).toBe(1);
    expect(t.io.err).toEqual([notPrimaryAddLine('imac')]);
  });

  it('refuses before asking the server: no code, its own code, another relay, run out', async () => {
    const own = encodePairingCode(JSON.stringify({ v: 1, relay: 'wss://relay.example', mac, name: 'me', token: 't', secret: 's' }));
    for (const [code, snapshot] of [
      ['nonsense', status()],
      [own, status({ macId: mac })],
      [qr({ relay: 'wss://other.example' }), status()],
      [qr({ expiresAt: NOW - 1 }), status()],
    ] as const) {
      const s = fakeServer([snapshot]);
      const t = scriptedIo();
      expect(await joinFlow({ call: s.call, io: t.api }, code)).toBe(1);
      expect(t.io.err).toHaveLength(1);
      expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
    }
  });

  it('reads a join whose roster never came, and marks the notice read', async () => {
    const { call, calls } = fakeServer([
      status(), status({ joining }), status({}, { joinExpired: { id: mac, name: 'mac-studio' } }),
    ], { 'POST /api/remote/join': joined, 'POST /api/remote/join/expired/acknowledge': { status: 200, body: { ok: true } } });
    const { api } = scriptedIo();
    expect(await joinFlow({ call, io: api }, qr())).toBe(1);
    expect(calls.at(-1)).toMatchObject({ path: '/api/remote/join/expired/acknowledge' });
  });
});

describe('addFlow', () => {
  const manager = { by: 'here' as const, newGroup: true };
  const pendingPair = { phone: 'p1', name: 'Pixel 8', platform: 'android', kind: 'phone', attemptsLeft: 3, manager };
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
    expect(io.out).toContain(encodePairingCode('{"v":1}'));
    expect(io.out).toContain(`${joinSentence(pendingPair)}. ${JOIN_REACH}`);
    expect(io.out).toContain(managerWords(manager, 'Pixel 8').line);
    expect(io.err).toEqual([attemptsLine(2)]);
    expect(calls.filter((c) => c.path === '/api/remote/pair/confirm').map((c) => c.body)).toEqual([
      { accept: true, phone: 'p1', code: '1111-2222' }, { accept: true, phone: 'p1', code: 'ABCD-1234' },
    ]);
  });

  it('answers a request already waiting without a new code; Enter rejects it', async () => {
    const { call, calls } = fakeServer([status({ pendingPair })], {
      'POST /api/remote/pair/confirm': { status: 200, body: { ok: true } },
    });
    const { api } = scriptedIo(['']);
    expect(await addFlow({ call, io: api })).toBe(0);
    expect(calls.some((c) => c.path === '/api/remote/pair')).toBe(false);
    expect(calls.at(-1)?.body).toEqual({ accept: false, phone: 'p1' });
  });

  it('ends the code prompt when the request runs out with its code, answering nothing', async () => {
    const s = fakeServer([status({ pendingPair, pairing: { expiresAt } })]);
    const t = scriptedIo([TIMED_OUT]);
    expect(await addFlow({ call: s.call, io: t.api })).toBe(1);
    expect(t.io.err).toEqual([REQUEST_EXPIRED]);
    expect(s.calls.some((c) => c.path === '/api/remote/pair/confirm')).toBe(false);
  });

  it('ends on the last wrong code, a full group, and a request that is gone', async () => {
    for (const [reply, lines] of [
      [{ status: 409, body: { error: 'code_rejected' } }, [CODE_REJECTED]],
      [{ status: 409, body: { error: 'group_full' } }, [GROUP_FULL, groupFullBody('Pixel 8')]],
      [{ status: 404, body: { error: 'no_pending' } }, null],
    ] as const) {
      const s = fakeServer([status({ pendingPair })], { 'POST /api/remote/pair/confirm': reply });
      const t = scriptedIo(['ABCD-1234']);
      expect(await addFlow({ call: s.call, io: t.api })).toBe(1);
      if (lines) expect(t.io.err).toEqual(lines);
      else expect(t.io.err).toHaveLength(1);
    }
    const s = fakeServer([status(), status({ pairing: { expiresAt } })], { 'POST /api/remote/pair': code });
    const t = scriptedIo();
    expect(await addFlow({ call: s.call, io: t.api })).toBe(1);
    expect(s.calls.some((c) => c.path === '/api/remote/pair/confirm')).toBe(false);
  });

  it('gives a member the not_primary line naming the primary', async () => {
    const s = fakeServer([status()], {
      'POST /api/remote/pair': { status: 403, body: { error: 'not_primary', primary: { id: 'm', name: 'mac-studio' } } },
    });
    const t = scriptedIo();
    expect(await addFlow({ call: s.call, io: t.api })).toBe(1);
    expect(t.io.err).toEqual([notPrimaryAddLine('mac-studio')]);
  });
});

describe('confirmations', () => {
  const group = status({ devices: [paired('mac', 'mac-studio')] }, {
    members: [member({ id: 'self-id', name: 'gpu-box', self: true, primary: true }), member({ id: 'mac', name: 'mac-studio' })],
    isPrimary: true, primary: { id: 'self-id', name: 'gpu-box' }, relayLocked: true,
  });
  const run = (argv: string[], s: ReturnType<typeof fakeServer>, t: ReturnType<typeof scriptedIo>) =>
    runCli(argv, { call: s.call, io: t.api, port: 1 });

  it('asks before a removal, and only a yes removes', async () => {
    const words = removeWords('mac-studio');
    for (const [answer, removed] of [['n', false], ['', false], ['y', true], ['YES', true]] as const) {
      const s = fakeServer([group], { 'DELETE /api/remote/devices/mac': { status: 200, body: { ok: true } } });
      const t = scriptedIo([answer]);
      expect(await run(['devices', 'remove', 'mac-studio'], s, t)).toBe(removed ? 0 : 1);
      expect(t.io.asked[0]).toContain(`${words.question} ${words.body}`);
      expect(s.calls.some((c) => c.method === 'DELETE')).toBe(removed);
    }
  });

  it('dissolves on the primary with the dissolve words, and --yes skips the question', async () => {
    const s = fakeServer([group], { 'POST /api/remote/leave': { status: 200, body: { ok: true } } });
    const t = scriptedIo();
    expect(await run(['devices', 'leave', '--yes'], s, t)).toBe(0);
    expect(t.io.asked).toEqual([]);
    expect(s.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/remote/leave' });
    const u = scriptedIo(['n']);
    const v = fakeServer([group]);
    expect(await run(['devices', 'leave'], v, u)).toBe(1);
    const words = exitWords('dissolve', 1, 'gpu-box');
    expect(u.io.asked[0]).toContain(`${words.question} ${words.body}`);
    expect(v.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('keeps the relay and its secret while in a group', async () => {
    for (const argv of [['relay', 'set', 'wss://new.example'], ['relay', 'secret', '--clear']]) {
      const s = fakeServer([group]);
      const t = scriptedIo();
      expect(await run(argv, s, t)).toBe(1);
      expect(t.io.err).toEqual([relayLockedLine('primary')]);
      expect(s.calls.some((c) => c.method === 'PATCH')).toBe(false);
    }
  });

  const settings = (url: string, secret: string) => ({ 'GET /api/settings': { status: 200, body: { remote_relay_url: url, remote_relay_secret: secret } } });
  const saved = { 'PATCH /api/settings': { status: 200, body: { ok: true } } };

  it('sets the relay and turns the remote on', async () => {
    const s = fakeServer([status({ enabled: false, relayUrl: '' })], { ...settings('', ''), ...saved });
    const t = scriptedIo();
    expect(await run(['relay', 'set', 'wss://new.example'], s, t)).toBe(0);
    expect(s.calls.at(-1)?.body).toEqual({ remote_relay_url: 'wss://new.example', remote_enabled: 'true' });
  });

  it('takes the secret at an unechoed prompt with the URL, and never prints it', async () => {
    const s = fakeServer([status({ enabled: false, relayUrl: '' })], { ...settings('', ''), ...saved });
    const t = scriptedIo(['hunter2']);
    expect(await run(['relay', 'set', 'wss://new.example', '--secret'], s, t)).toBe(0);
    expect(t.io.secrets).toBe(1);
    expect(s.calls.at(-1)?.body).toEqual({ remote_relay_url: 'wss://new.example', remote_relay_secret: 'hunter2', remote_enabled: 'true' });
    expect([...t.io.out, ...t.io.err].join('\n')).not.toContain('hunter2');
  });

  it('changes only the secret from stdin; with paired devices it asks with the secret words', async () => {
    const remote = status({ devices: [paired('ph', 'Pixel')] });
    const s = fakeServer([remote], { ...settings('wss://relay.example', 'old'), ...saved, 'DELETE /api/remote/devices/ph': { status: 200, body: { ok: true } } });
    const t = scriptedIo(['new-secret', 'y']);
    expect(await run(['relay', 'secret', '--secret-stdin'], s, t)).toBe(0);
    expect(t.io.secrets).toBe(0);
    const words = relayChangeWords(1, 'secret');
    expect(t.io.asked[1]).toContain(`${words.title} ${words.body}`);
    expect(s.calls.map((c) => `${c.method} ${c.path}`).slice(-2)).toEqual(['DELETE /api/remote/devices/ph', 'PATCH /api/settings']);
    expect(s.calls.at(-1)?.body).toEqual({ remote_relay_secret: 'new-secret' });
    expect([...t.io.out, ...t.io.err].join('\n')).not.toContain('new-secret');
  });

  it('clears the secret without asking, as the settings page does', async () => {
    const s = fakeServer([status({ devices: [paired('ph', 'Pixel')] })], { ...settings('wss://relay.example', 'old'), ...saved });
    const t = scriptedIo();
    expect(await run(['relay', 'secret', '--clear'], s, t)).toBe(0);
    expect(t.io.asked).toEqual([]);
    expect(s.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(s.calls.at(-1)?.body).toEqual({ remote_relay_secret: '' });
  });

  it('shows whether a secret is set, not the secret', async () => {
    const s = fakeServer([status()], settings('wss://relay.example', 'hunter2'));
    const t = scriptedIo();
    expect(await run(['relay'], s, t)).toBe(0);
    expect(t.io.out.join('\n')).not.toContain('hunter2');
    expect(t.io.out.at(-1)).toMatch(/secret: set$/);
  });

  it('asks before an update that stops working sessions', async () => {
    const state = { installed: '0.35.0', candidate: '0.36.0', packaged: true, updating: false, failed: null, sessions: 2, startedBy: null };
    for (const [answer, posted] of [['n', false], ['u', true], ['w', true]] as const) {
      const s = fakeServer([status()], {
        'GET /api/server/update': { status: 200, body: state },
        'POST /api/server/update': { status: 202, body: { ...state, updating: true } },
      });
      const t = scriptedIo([answer]);
      expect(await run(['update'], s, t)).toBe(posted ? 0 : 1);
      expect(t.io.asked).toHaveLength(1);
      expect(s.calls.some((c) => c.method === 'POST')).toBe(posted);
    }
  });
});

describe('updateTarget', () => {
  const remote = status({}, {
    members: [
      member({ id: 'self-id', name: 'gpu-box', kind: 'headless', os: 'linux', self: true, state: 'self' }),
      member({ id: 'nuc-id', name: 'nuc', kind: 'headless', os: 'linux' }),
      member({ id: 'px', name: 'Pixel 8', kind: 'phone', os: 'android', version: null }),
      member({ id: 'air', name: 'air-m3', state: 'offline' }),
      member({ id: 'old', name: 'old-mac', version: '0.30.0' }),
      member({ id: 'tooold', name: 'ancient', tooOld: true }),
    ],
  });

  it('is this device with no name or its own name, and a member through this one by name or id', () => {
    expect(updateTarget(remote, null)).toEqual({ machine: null, name: 'gpu-box' });
    expect(updateTarget(remote, 'gpu-box')).toEqual({ machine: null, name: 'gpu-box' });
    expect(updateTarget(remote, 'nuc')).toEqual({ machine: 'nuc-id', name: 'nuc' });
    expect(updateTarget(remote, 'nuc-id')).toEqual({ machine: 'nuc-id', name: 'nuc' });
  });

  it('refuses a phone, a member not online, one too old for the route, and a name it does not know', () => {
    expect(updateTarget(remote, 'Pixel 8')).toEqual({ error: expect.stringContaining('store') });
    expect(updateTarget(remote, 'air-m3')).toEqual({ error: expect.stringContaining('offline') });
    expect(updateTarget(remote, 'old-mac')).toEqual({ error: expect.stringContaining('0.30.0') });
    expect(updateTarget(remote, 'ancient')).toHaveProperty('error');
    expect(updateTarget(remote, 'nope')).toHaveProperty('error');
  });
});

describe('update', () => {
  const remote = status({}, {
    members: [
      member({ id: 'self-id', name: 'gpu-box', kind: 'headless', os: 'linux', self: true, state: 'self' }),
      member({ id: 'nuc-id', name: 'nuc', kind: 'headless', os: 'linux' }),
      member({ id: 'px', name: 'Pixel 8', kind: 'phone', os: 'android', version: null }),
      member({ id: 'air', name: 'air-m3', state: 'offline' }),
    ],
  });
  const state = {
    installed: '0.35.0', candidate: '0.36.0', packaged: true, updating: false, failed: null, sessions: 3, startedBy: null,
  };
  const run = (argv: string[], s: ReturnType<typeof fakeServer>, t: ReturnType<typeof scriptedIo>) =>
    runCli(argv, { call: s.call, io: t.api, port: 1 });

  it('updates a member through this server, asking first in the row\'s words with its three choices', async () => {
    const words = updateSessionsWords(3, 'nuc');
    for (const [answer, posted] of [['n', null], ['y', null], ['', null], ['u', 'now'], ['w', 'idle']] as const) {
      const s = fakeServer([remote], {
        'GET /api/server/update?machine=nuc-id': { status: 200, body: state },
        'POST /api/server/update?machine=nuc-id': { status: 202, body: { ...state, updating: true } },
      });
      const t = scriptedIo([answer]);
      expect(await run(['update', 'nuc'], s, t)).toBe(posted ? 0 : 1);
      expect(t.io.asked[0]).toContain(`${words.question} ${words.body}`);
      expect(t.io.asked[0]).toContain('Update when sessions finish');
      const post = s.calls.find((c) => c.method === 'POST' && c.path === '/api/server/update?machine=nuc-id');
      expect(post !== undefined, answer).toBe(posted !== null);
      if (post) expect(post.body).toEqual(posted === 'idle' ? { when: 'idle' } : undefined);
      expect(s.calls.some((c) => c.path === '/api/server/update')).toBe(false);
    }
  });

  it('--when-idle waits without asking, and says what it waits for', async () => {
    const s = fakeServer([remote], {
      'GET /api/server/update?machine=nuc-id': { status: 200, body: state },
      'POST /api/server/update?machine=nuc-id': { status: 202, body: { ...state, updating: true, waiting: { sessions: 3 } } },
    });
    const t = scriptedIo();
    expect(await run(['update', 'nuc', '--when-idle'], s, t)).toBe(0);
    expect(t.io.asked).toEqual([]);
    expect(s.calls.at(-1)).toMatchObject({ method: 'POST', body: { when: 'idle' } });
    expect(t.io.out.at(-1)).toBe('nuc: Waiting for 3 sessions to finish · then 0.36.0. orbital update --cancel nuc stops the wait.');
  });

  it('--cancel ends a wait on this device or a member, and says when there is none', async () => {
    const s = fakeServer([remote], {
      'DELETE /api/server/update?machine=nuc-id': { status: 200, body: state },
      'DELETE /api/server/update': { status: 409, body: { error: 'not_waiting' } },
    });
    const t = scriptedIo();
    expect(await run(['update', '--cancel', 'nuc'], s, t)).toBe(0);
    expect(t.io.out.at(-1)).toBe('The update of nuc was cancelled. Nothing was installed.');
    expect(await run(['update', '--cancel'], s, t)).toBe(1);
    expect(t.io.err.at(-1)).toBe('No update is waiting here.');
    expect(s.calls.filter((c) => c.method === 'DELETE').map((c) => c.body)).toEqual([undefined, undefined]);
  });

  it('asks this device in the same words, by its own name', async () => {
    const s = fakeServer([remote], {
      'GET /api/server/update': { status: 200, body: state },
      'POST /api/server/update': { status: 202, body: { ...state, updating: true } },
    });
    const t = scriptedIo(['u']);
    expect(await run(['update'], s, t)).toBe(0);
    const words = updateSessionsWords(3, 'gpu-box');
    expect(t.io.asked[0]).toContain(`${words.question} ${words.body}`);
    expect(s.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/server/update' });
  });

  it('asks nothing of a phone or an offline member, and says so when the member drops before it answers', async () => {
    for (const name of ['Pixel 8', 'air-m3']) {
      const s = fakeServer([remote]);
      const t = scriptedIo();
      expect(await run(['update', name], s, t)).toBe(1);
      expect(s.calls.every((c) => c.path === '/api/remote')).toBe(true);
    }
    const s = fakeServer([remote], { 'GET /api/server/update?machine=nuc-id': { status: 409, body: { error: 'member_offline' } } });
    // A CliError: main prints it and exits 1.
    await expect(run(['update', 'nuc'], s, scriptedIo())).rejects.toThrow('nuc is offline. Update it once it is online.');
  });

  it('reads a member from before the route as too old, not as an error', async () => {
    const s = fakeServer([remote], { 'GET /api/server/update?machine=nuc-id': { status: 404, body: { message: 'Route not found' } } });
    const t = scriptedIo();
    expect(await run(['update', 'nuc'], s, t)).toBe(1);
    expect(t.io.err[0]).toContain('older than updates from the group');
  });

  it('devices list asks only the members that serve the route, this device without ?machine=', async () => {
    const s = fakeServer([remote], {
      'GET /api/server/update': { status: 200, body: { ...state, candidate: '0.35.0' } },
      'GET /api/server/update?machine=nuc-id': { status: 200, body: state },
    });
    const t = scriptedIo();
    expect(await run(['devices', 'list'], s, t)).toBe(0);
    expect(s.calls.filter((c) => c.path.startsWith('/api/server/update')).map((c) => c.path).sort())
      .toEqual(['/api/server/update', '/api/server/update?machine=nuc-id']);
    expect(t.io.out.find((l) => l.startsWith('nuc '))).toContain('update available · 0.36.0');
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
      expect(t.io.out[0]).toContain(String(port));
      expect(t.io.err).toEqual([]);

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
